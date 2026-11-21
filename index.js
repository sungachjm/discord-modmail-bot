require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');

const {
  TOKEN,
  GUILD_ID,
  MODMAIL_CATEGORY_ID, // category chứa các ticket modmail (nên để riêng tư cho staff)
  MODMAIL_LOG_CHANNEL_ID, // kênh lưu transcript khi đóng ticket (không bắt buộc)
  REPORT_CHANNEL_ID, // kênh nhận báo cáo
  STAFF_ROLE_ID, // role được ping khi có ticket/báo cáo mới (không bắt buộc)
} = process.env;

// Kiểm tra biến môi trường bắt buộc, thiếu thì báo rõ rồi dừng
const missing = ['TOKEN', 'GUILD_ID', 'MODMAIL_CATEGORY_ID', 'REPORT_CHANNEL_ID'].filter(
  (k) => !process.env[k]?.trim(),
);
if (missing.length) {
  console.error(`❌ Thiếu biến môi trường: ${missing.join(', ')}`);
  process.exit(1);
}

const COLOR = 0x2b2d31; // nhìn như "trong suốt" ở dark mode
const GREEN = 0x57f287;
const RED = 0xed4245;
const TOPIC_PREFIX = 'modmail:';
const REPORT_COOLDOWN_MS = 30_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // nhớ bật Message Content Intent trong Developer Portal
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ---------- Slash / context menu definitions ----------
const commands = [
  new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Quản lý modmail')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Gửi bảng hướng dẫn liên hệ moderator vào kênh này'),
    )
    .addSubcommand((s) =>
      s
        .setName('close')
        .setDescription('Đóng ticket modmail hiện tại')
        .addStringOption((o) =>
          o.setName('reason').setDescription('Lý do đóng').setMaxLength(500),
        ),
    ),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Báo cáo người dùng hoặc tin nhắn vi phạm')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('user_or_message')
        .setDescription('@người dùng, ID, hoặc link tin nhắn')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('reason').setDescription('Lý do báo cáo').setRequired(true).setMaxLength(1000),
    )
    .addAttachmentOption((o) =>
      o.setName('evidence').setDescription('Ảnh/bằng chứng (không bắt buộc)'),
    ),

  new ContextMenuCommandBuilder()
    .setName('Report message')
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild),

  new ContextMenuCommandBuilder()
    .setName('Report user')
    .setType(ApplicationCommandType.User)
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

// ---------- Helpers ----------
const staffPing = () => ({
  content: STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}>` : undefined,
  allowedMentions: STAFF_ROLE_ID ? { roles: [STAFF_ROLE_ID] } : { parse: [] },
});

function buildRelayEmbed({ content, attachments, color, name, iconURL, footer }) {
  const embed = new EmbedBuilder().setColor(color).setAuthor({ name, iconURL }).setTimestamp();
  const files = [...(attachments?.values() ?? [])];
  const img = files.find((a) => a.contentType?.startsWith('image/'));
  const others = files.filter((a) => a !== img);

  if (content) embed.setDescription(content.slice(0, 4000));
  else if (!files.length) embed.setDescription('*(tin nhắn trống)*');
  if (img) embed.setImage(img.url);
  if (others.length) {
    embed.addFields({
      name: 'Tệp đính kèm',
      value: others.map((a) => `[${a.name}](${a.url})`).join('\n').slice(0, 1024),
    });
  }
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

const findTicket = (guild, userId) =>
  guild.channels.cache.find(
    (c) => c.parentId === MODMAIL_CATEGORY_ID && c.topic === `${TOPIC_PREFIX}${userId}`,
  );

// Chống spam báo cáo
const cooldown = new Map();
const reportedKeys = new Set();
function canReport(userId, key) {
  const now = Date.now();
  if (now - (cooldown.get(userId) ?? 0) < REPORT_COOLDOWN_MS) return false;
  if (key && reportedKeys.has(`${userId}:${key}`)) return false;
  cooldown.set(userId, now);
  if (key) reportedKeys.add(`${userId}:${key}`);
  return true;
}

// ---------- MODMAIL: DM -> staff ----------
async function relayDmToStaff(msg) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const member = await guild.members.fetch(msg.author.id).catch(() => null);
  if (!member) {
    return msg.reply('Bạn cần ở trong server để dùng modmail.').catch(() => {});
  }

  let channel = findTicket(guild, msg.author.id);
  let isNew = false;

  if (!channel) {
    isNew = true;
    const base =
      msg.author.username.toLowerCase().replace(/[^a-z0-9_-]/g, '') || msg.author.id.slice(-4);
    channel = await guild.channels.create({
      name: `modmail-${base}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: MODMAIL_CATEGORY_ID,
      topic: `${TOPIC_PREFIX}${msg.author.id}`,
    });

    const info = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Ticket modmail mới')
      .setThumbnail(msg.author.displayAvatarURL())
      .addFields(
        { name: 'Người dùng', value: `${msg.author} (${msg.author.id})` },
        { name: 'Tạo tài khoản', value: `<t:${Math.floor(msg.author.createdTimestamp / 1000)}:R>`, inline: true },
        {
          name: 'Vào server',
          value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Không rõ',
          inline: true,
        },
      )
      .setFooter({ text: 'Chat trong kênh này để trả lời • Bắt đầu bằng // để ghi chú nội bộ • /modmail close để đóng' });
    await channel.send({ ...staffPing(), embeds: [info] });
  }

  await channel.send({
    embeds: [
      buildRelayEmbed({
        content: msg.content,
        attachments: msg.attachments,
        color: COLOR,
        name: msg.author.username,
        iconURL: msg.author.displayAvatarURL(),
      }),
    ],
  });

  await msg.react('✅').catch(() => {});
  if (isNew) {
    await msg
      .reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR)
            .setTitle('Đã gửi tới ban quản trị')
            .setDescription('Moderator sẽ phản hồi bạn sớm nhất có thể. Bạn cứ nhắn thêm ở đây nếu cần bổ sung.'),
        ],
      })
      .catch(() => {});
  }
}

// ---------- MODMAIL: staff -> DM ----------
async function relayStaffToDm(msg) {
  const topic = msg.channel.topic;
  if (!topic?.startsWith(TOPIC_PREFIX)) return;
  if (msg.content.startsWith('//')) return; // ghi chú nội bộ, không gửi cho user

  const user = await client.users.fetch(topic.slice(TOPIC_PREFIX.length)).catch(() => null);
  if (!user) return msg.reply('Không tìm thấy người dùng này nữa.').catch(() => {});

  try {
    await user.send({
      embeds: [
        buildRelayEmbed({
          content: msg.content,
          attachments: msg.attachments,
          color: GREEN,
          name: msg.guild.name,
          iconURL: msg.guild.iconURL() ?? undefined,
          footer: 'Ban quản trị',
        }),
      ],
    });
    await msg.react('✅').catch(() => {});
  } catch {
    await msg.react('❌').catch(() => {});
    await msg.reply('Không gửi được DM (người dùng có thể đã tắt DM).').catch(() => {});
  }
}

// ---------- /modmail setup ----------
async function modmailSetup(i) {
  const contact = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Contact Moderators')
    .setDescription(
      `Nếu bạn gặp vấn đề liên quan đến quản trị, hãy nhắn tin cho bot **${client.user.username}** ` +
        'hoặc bấm nút bên dưới. Moderator sẽ phản hồi sớm nhất có thể.',
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('DM Modmail')
      .setURL(`https://discord.com/users/${client.user.id}`),
  );

  const reports = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Message and User Reports')
    .setDescription(
      'Nếu bạn thấy nội dung vi phạm nội quy, hãy báo cáo bằng một trong các cách sau:\n\n' +
        '**1.** Dùng lệnh `/report`\n' +
        '**2.** Thả reaction 🛡️ vào tin nhắn vi phạm\n' +
        '**3.** Chuột phải tin nhắn/người dùng → **Apps** → `Report message` hoặc `Report user`',
    );

  await i.channel.send({ embeds: [contact], components: [row] });
  await i.channel.send({ embeds: [reports] });
  await i.reply({ content: '✅ Đã gửi bảng hướng dẫn.', flags: MessageFlags.Ephemeral });
}

// ---------- /modmail close ----------
async function fetchAll(channel, max = 500) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    out.push(...batch.values());
    before = batch.last().id;
  }
  return out.reverse(); // cũ -> mới
}

async function modmailClose(i) {
  const channel = i.channel;
  if (!channel.topic?.startsWith(TOPIC_PREFIX)) {
    return i.reply({ content: '❌ Lệnh này chỉ dùng trong kênh ticket modmail.', flags: MessageFlags.Ephemeral });
  }
  const reason = i.options.getString('reason') ?? 'Không có lý do';
  await i.reply('🔒 Đang đóng ticket...');

  const userId = channel.topic.slice(TOPIC_PREFIX.length);
  const user = await client.users.fetch(userId).catch(() => null);

  // Transcript
  const messages = await fetchAll(channel);
  const lines = messages.map((m) => {
    const e = m.embeds[0];
    const who = e?.author?.name ?? m.author.username;
    const text = m.content || e?.description || '';
    const files = [...m.attachments.values(), ...(e?.image ? [e.image] : [])].map((a) => a.url);
    return `[${new Date(m.createdTimestamp).toISOString()}] ${who}: ${text}${files.length ? ` (${files.join(', ')})` : ''}`;
  });

  const logChannel = MODMAIL_LOG_CHANNEL_ID && i.guild.channels.cache.get(MODMAIL_LOG_CHANNEL_ID);
  if (logChannel) {
    await logChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(RED)
            .setTitle('Ticket modmail đã đóng')
            .addFields(
              { name: 'Người dùng', value: `<@${userId}> (${userId})`, inline: true },
              { name: 'Đóng bởi', value: `${i.user}`, inline: true },
              { name: 'Lý do', value: reason },
            )
            .setTimestamp(),
        ],
        files: [new AttachmentBuilder(Buffer.from(lines.join('\n') || '(trống)'), { name: `transcript-${userId}.txt` })],
      })
      .catch(console.error);
  }

  await user
    ?.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('Ticket đã được đóng')
          .setDescription(`Lý do: ${reason}\n\nNếu cần hỗ trợ thêm, cứ nhắn tin lại cho bot để mở ticket mới.`),
      ],
    })
    .catch(() => {});

  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ---------- REPORTS ----------
async function submitReport({ guild, reporter, target, message, reason, evidence }) {
  const channel = guild.channels.cache.get(REPORT_CHANNEL_ID);
  if (!channel) throw new Error('NO_REPORT_CHANNEL');

  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle(message ? 'Báo cáo tin nhắn' : 'Báo cáo người dùng')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'Người báo cáo', value: `${reporter} (${reporter.id})`, inline: true },
      { name: 'Bị báo cáo', value: `${target} (${target.id})`, inline: true },
      { name: 'Lý do', value: reason.slice(0, 1024) },
    )
    .setTimestamp();

  if (message) {
    embed.addFields({ name: 'Nội dung tin nhắn', value: message.content?.slice(0, 1000) || '*(không có chữ)*' });
    const img = [...message.attachments.values()].find((a) => a.contentType?.startsWith('image/'));
    if (img) embed.setImage(img.url);
  }
  if (evidence) {
    if (evidence.contentType?.startsWith('image/')) embed.setImage(evidence.url);
    else embed.addFields({ name: 'Bằng chứng', value: evidence.url });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('report_resolve').setLabel('Đánh dấu đã xử lý').setStyle(ButtonStyle.Success),
  );
  if (message) {
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Đến tin nhắn').setURL(message.url));
  }

  await channel.send({ ...staffPing(), embeds: [embed], components: [row] });
}

const MSG_LINK = /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
async function parseTarget(guild, input) {
  const m = input.match(MSG_LINK);
  if (m) {
    if (m[1] !== guild.id) return null;
    const ch = await guild.channels.fetch(m[2]).catch(() => null);
    const message = ch?.isTextBased() ? await ch.messages.fetch(m[3]).catch(() => null) : null;
    return message ? { message, user: message.author } : null;
  }
  const id = input.match(/\d{17,20}/)?.[0];
  if (id) {
    const user = await client.users.fetch(id).catch(() => null);
    if (user) return { user };
  }
  return null;
}

async function slashReport(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const target = await parseTarget(i.guild, i.options.getString('user_or_message', true));
  if (!target) return i.editReply('❌ Không tìm thấy người dùng/tin nhắn. Hãy dùng @mention, ID hoặc link tin nhắn trong server này.');
  if (target.user.id === i.user.id) return i.editReply('❌ Bạn không thể tự báo cáo chính mình.');
  if (!canReport(i.user.id, target.message?.id)) return i.editReply('⏳ Bạn báo cáo quá nhanh hoặc đã báo cáo tin nhắn này rồi.');

  await submitReport({
    guild: i.guild,
    reporter: i.user,
    target: target.user,
    message: target.message,
    reason: i.options.getString('reason', true),
    evidence: i.options.getAttachment('evidence'),
  });
  return i.editReply('✅ Đã gửi báo cáo tới ban quản trị. Cảm ơn bạn!');
}

const reasonModal = (customId, title) =>
  new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Lý do báo cáo')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );

async function modalReport(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = i.fields.getTextInputValue('reason');
  let message = null;
  let user = null;

  if (i.customId.startsWith('rm:')) {
    const [, channelId, messageId] = i.customId.split(':');
    const ch = await i.guild.channels.fetch(channelId).catch(() => null);
    message = await ch?.messages.fetch(messageId).catch(() => null);
    user = message?.author;
  } else if (i.customId.startsWith('ru:')) {
    user = await client.users.fetch(i.customId.split(':')[1]).catch(() => null);
  } else return;

  if (!user) return i.editReply('❌ Không tìm thấy đối tượng cần báo cáo.');
  if (user.id === i.user.id) return i.editReply('❌ Bạn không thể tự báo cáo chính mình.');
  if (!canReport(i.user.id, message?.id)) return i.editReply('⏳ Bạn báo cáo quá nhanh hoặc đã báo cáo tin nhắn này rồi.');

  await submitReport({ guild: i.guild, reporter: i.user, target: user, message, reason });
  return i.editReply('✅ Đã gửi báo cáo tới ban quản trị. Cảm ơn bạn!');
}

async function resolveReport(i) {
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
    return i.reply({ content: '❌ Bạn không có quyền xử lý báo cáo.', flags: MessageFlags.Ephemeral });
  }
  const embed = EmbedBuilder.from(i.message.embeds[0])
    .setColor(GREEN)
    .setFooter({ text: `Đã xử lý bởi ${i.user.username}` });
  const row = ActionRowBuilder.from(i.message.components[0]);
  row.components.forEach((b) => {
    if (b.data.custom_id === 'report_resolve') b.setDisabled(true).setLabel('Đã xử lý');
  });
  return i.update({ embeds: [embed], components: [row] });
}

// ---------- Events ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Đăng nhập: ${c.user.tag}`);
  const guild = await c.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log('📌 Đã đăng ký lệnh');
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  try {
    if (msg.channel.type === ChannelType.DM) return await relayDmToStaff(msg);
    if (msg.guildId === GUILD_ID && msg.channel.parentId === MODMAIL_CATEGORY_ID) {
      return await relayStaffToDm(msg);
    }
  } catch (err) {
    console.error(err);
  }
});

// Reaction 🛡️ để báo cáo
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (!reaction.emoji.name?.startsWith('🛡')) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch {
    return;
  }

  const message = reaction.message;
  if (message.guildId !== GUILD_ID) return;

  // Gỡ reaction để người báo cáo được ẩn danh (cần quyền Manage Messages)
  reaction.users.remove(user.id).catch(() => {});

  if (message.author.bot || message.author.id === user.id) return;
  if (!canReport(user.id, message.id)) return;

  try {
    await submitReport({
      guild: message.guild,
      reporter: user,
      target: message.author,
      message,
      reason: 'Báo cáo bằng reaction 🛡️',
    });
    user.send('✅ Đã gửi báo cáo tới ban quản trị. Cảm ơn bạn!').catch(() => {});
  } catch (err) {
    console.error(err);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'modmail') {
        return i.options.getSubcommand() === 'setup' ? await modmailSetup(i) : await modmailClose(i);
      }
      if (i.commandName === 'report') return await slashReport(i);
    } else if (i.isMessageContextMenuCommand() && i.commandName === 'Report message') {
      return await i.showModal(reasonModal(`rm:${i.targetMessage.channelId}:${i.targetMessage.id}`, 'Report message'));
    } else if (i.isUserContextMenuCommand() && i.commandName === 'Report user') {
      return await i.showModal(reasonModal(`ru:${i.targetUser.id}`, 'Report user'));
    } else if (i.isModalSubmit()) {
      return await modalReport(i);
    } else if (i.isButton() && i.customId === 'report_resolve') {
      return await resolveReport(i);
    }
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ Có lỗi xảy ra, thử lại sau nhé.' };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// Server HTTP nhỏ cho Render (cần cổng mở) và để UptimeRobot ping giữ bot thức
require('http')
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive');
  })
  .listen(process.env.PORT || 3000, () => console.log('🌐 HTTP server đang chạy'));

client.login(TOKEN);
