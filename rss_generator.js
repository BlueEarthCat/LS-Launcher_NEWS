import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { format } from "date-fns-tz";
import { Octokit } from "@octokit/rest";

dotenv.config();

// === 환경 변수 ===
const CHANNEL_ID = process.env.CHANNEL_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const RSS_FILE = "news.xml";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ==================== XML/HTML 처리 함수 ====================
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateDescription(htmlContent) {
  let text = htmlContent;
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  text = text.replace(/^>+/gm, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 150) text = text.slice(0, 150) + '...';
  return text;
}

function discordMessageToHeliosRSS(msg) {
  msg = msg.replace(/<:[^:]+:\d+>/g, '');
  msg = msg.replace(/@\S+/g, '');
  msg = msg.replace(/\|{2,}/g, '');
  msg = msg.replace(/<#[0-9]+>/g, '');

  msg = msg.replace(
    /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w\-]+)/g,
    '<a href="$1" target="_blank">$1</a>'
  );
  msg = msg.replace(
    /(https?:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?)/g,
    '<a href="$1" target="_blank">$1</a>'
  );

  msg = msg.replace(/^##\s*(.+)$/gm, '<h2>$1</h2>');
  msg = msg.replace(/^#\s*(.+)$/gm, '<h1>$1</h1>');
  msg = msg.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  msg = msg.replace(/``(.+?)``/g, '<span class="highlight">$1</span>');

  const lines = msg.split('\n');
  const result = [];
  let inList = false;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('- ')) {
      if (!inList) { inList = true; result.push('<ul>'); }
      result.push('<li>' + line.slice(2) + '</li>');
    } else {
      if (inList) { result.push('</ul>'); inList = false; }
      if (line !== '') result.push('<p>' + line + '</p>');
    }
  }
  if (inList) result.push('</ul>');

  let htmlContent = result.join('\n');
  htmlContent = htmlContent.replace(/<p>\s*(<h[1-6]>.*?<\/h[1-6]>)\s*<\/p>/g, '$1');

  const titleMatch = htmlContent.match(/<h1>(.*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1] : htmlContent.replace(/<[^>]+>/g, '').slice(0, 50);

  return { title, content: htmlContent };
}

function createRSSItem(message) {
  const rssItem = discordMessageToHeliosRSS(message.content);
  const title = rssItem.title || "새 공지사항";
  const link = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  const guid = `lastsaviors-${format(new Date(message.createdTimestamp), "yyyyMMddHHmmss", { timeZone: "Asia/Seoul" })}`;
  const pubDate = new Date(message.createdTimestamp).toUTCString();
  const author = `${message.author.username} (라스트 세이비어스 운영팀)`;
  const description = generateDescription(rssItem.content);

  return `
<item>
  <title>${escapeXml(title)}</title>
  <link>${link}</link>
  <guid isPermaLink="false">${guid}</guid>
  <pubDate>${pubDate}</pubDate>
  <author>${escapeXml(author)}</author>
  <description>${escapeXml(description)}</description>
  <content:encoded><![CDATA[
${rssItem.content}
  ]]></content:encoded>
</item>`;
}

// ==================== GitHub API로 news.xml 업데이트 ====================
async function appendRSSItem(itemXml, newGuid) {
  try {
    const { data: file } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: RSS_FILE,
      ref: BRANCH,
    });

    const sha = file.sha;
    const content = Buffer.from(file.content, "base64").toString("utf-8");

    // ===== 중복 체크 =====
    if (content.includes(newGuid)) {
      console.log("⚠️ 이미 RSS에 존재하는 메시지입니다. 건너뜀.");
      return;
    }

    // ===== 맨 위에 새 item 삽입 =====
    let updatedXml;
    if (content.includes("<item>")) {
      updatedXml = content.replace(/(<channel[^>]*>\s*)/s, `$1${itemXml}\n`);
    } else {
      updatedXml = content.replace(/(<\/channel>)/, `${itemXml}\n$1`);
    }

    // lastBuildDate 갱신
    updatedXml = updatedXml.replace(
      /<lastBuildDate>.*?<\/lastBuildDate>/,
      `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`
    );

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: RSS_FILE,
      message: `Update news.xml - add new RSS item`,
      content: Buffer.from(updatedXml).toString("base64"),
      sha,
      branch: BRANCH,
    });

    console.log("🚀 GitHub news.xml 업데이트 완료! (맨 위 추가)");
  } catch (err) {
    console.error("❌ GitHub 업데이트 실패:", err);
  }
}

// ==================== Discord 봇 ====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`🤖 로그인 성공: ${client.user.tag}`);
  console.log(`📡 감시 중인 채널: ${CHANNEL_ID}`);
});

client.on("messageCreate", async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.bot) return;

  const itemXml = createRSSItem(message);
  const newGuidMatch = itemXml.match(/<guid isPermaLink="false">(.*?)<\/guid>/);
  const newGuid = newGuidMatch ? newGuidMatch[1] : null;
  if (!newGuid) return;

  console.log(`📢 새 공지 감지됨: ${message.content.slice(0, 30)}...`);

  await appendRSSItem(itemXml, newGuid);
});

client.login(process.env.DISCORD_TOKEN);
