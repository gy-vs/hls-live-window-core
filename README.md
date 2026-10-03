# hls-live-window

一个只负责**算清楚"现在能播什么"**的 HLS 直播播放窗口跟踪库。

- 不下载任何媒体或 playlist（HTTP 由调用方完成）
- 不做界面、不依赖系统时钟、不做任何有副作用的事
- 同样的一串输入，无论何时、在哪台机器上跑，结果和顺序完全一致

播放器把反复拉到的 master / media playlist（新旧片段混在一起、甚至乱序到达）喂进来，然后可以问它：

1. 每个 rendition 现在**能播的片段范围**是什么；
2. 不同 rendition 之间**在哪里能对齐 / 安全切换**；
3. 哪些地方已经**确认缺了片段**，缺的是哪几个 MSN；
4. **下次什么时候刷新**，以及落后时的**追赶计划**。

## 安装

```bash
npm install hls-live-window
```

需要 Node.js >= 18，库为 ESM（也可被打包进浏览器/TS 工程）。

## 快速上手

```ts
import {
  HlsWindowTracker,
  parseMasterPlaylist,
  parseMediaPlaylist,
  getAlignment,
  getCatchupPlan,
  planRefreshAll,
} from 'hls-live-window';

const tracker = new HlsWindowTracker();

// 1) 喂入 master playlist（拿到 rendition 清单）
tracker.ingestMaster(
  parseMasterPlaylist(masterText, 'https://cdn/live/index.m3u8'),
);

// 2) 每次拉到 media playlist 就喂入；fetchedAtMs 由调用方给（整数毫秒）
const p = parseMediaPlaylist(mediaText, 'https://cdn/live/high/index.m3u8');
const result = tracker.ingestMedia(p, fetchedAtMs);
for (const d of result.diagnostics) console.warn(d.code, d.message);

// 3) 查询
for (const r of tracker.getPlayableRanges()) {
  // r.firstMsn / r.lastMsn / r.mode('live'|'event'|'vod') / r.ended
}

tracker.getMissingSegments();          // 已确认缺失的 MSN 区间
getAlignment(tracker.getPlayableRanges());   // 跨 rendition 对齐与安全切换点

const plan = getCatchupPlan(tracker.getPlayableRanges(), {
  position: { lastBufferedMsn: 120, renderedAtMs: null },
  nowMs: 1700000000000,
});
// plan.renditions[].startMsn / safeStartMsn / missedFromMsn..missedToMsn / behindMs

const schedule = planRefreshAll(tracker.getPlayableRanges());
// schedule.nextRefreshAt —— 到点再去拉，别自己定节奏
```

## 四个入口

| 入口 | 作用 |
| --- | --- |
| `parsePlaylist / parseMasterPlaylist / parseMediaPlaylist` | 解析 playlist 文本，相对 URI 一律解析成绝对 URI，时间统一成整数毫秒 |
| `HlsWindowTracker#ingestMaster / ingestMedia` | 合并新 playlist，返回本次产生的诊断（缺口、冲突等） |
| `getPlayableRanges / getMissingSegments / getAlignment` | 查询能播范围、已确认缺口、跨 rendition 对齐点 |
| `getCatchupPlan / planRefresh(All)` | 追赶（起播/续播/落后/结束）与下次刷新时间 |

## 行为约定（遇到这些情况会怎样）

**乱序到达不会让窗口回退。** 快照新旧按内容比较（尾 MSN、ENDLIST、头部序列号），
不按到达顺序。一份更旧的 playlist 晚到时 `ingestMedia` 返回 `accepted:false`，
当前能播范围保持不变；它与当前快照共享 MSN 上若有身份冲突仍会被报出来。

**缺口只在"新前沿"上确认。** 新窗口的头比旧窗口的尾多出空洞时才记缺口，并区分：

- `window-slide`：窗口正常滑动但刷新慢了，错过若干片段；
- `sequence-jump`：序列号一次跳过的数量 >= 上一窗口容量（插播切片源换源等）。

诊断消息都带 rendition id 与具体 MSN 区间（`fromMsn..toMsn`、`previousMsn`、`nextMsn`）。

**同一 MSN 不一定是同一片段。** 片段身份指纹包含：URI 的 path 部分、
byte range（长度+偏移）、加密 key（method / uri path / iv / keyformat）、
EXT-X-MAP。任一不同就报 `segment-identity-conflict` 并指出差异类别。
CDN 签名 URL 的 query 轮换**不**算差异（rendition 身份同样只看 URI path）。

**EVENT / VOD / 直播已结束：**

- `EVENT` 只许追加；一旦头部回退（删旧片段）报 `event-truncated`；
- 带 `ENDLIST` 的 playlist 是终态：内容再变报 `vod-content-changed`，
  字节级一致的重复投递算刷新成功，刷新计划变为"不再刷新"；
- 无 `PLAYLIST-TYPE` 但带 `ENDLIST` 视为 **live 模式 + `ended:true`**
  （直播自然结束），与 `vod` 区分。

**广告 / discontinuity：** 广告 pod 的 `EXT-X-DISCONTINUITY` 之后时间戳可能归零，
对齐以 `(MSN, discontinuitySequence)` 为准，安全切换点取各 rendition
共有的 discontinuity 起点；`EXT-X-INDEPENDENT-SEGMENTS` 下任意点都可切。
某 rendition 的标记位置和别人不一致时给出
`rendition-discontinuity-mismatch`（精确到 MSN），且该点不会被当作可切换点。

**刷新节奏（RFC 8216 §6.3.4）：** 首次距上次 fetch 一个 target duration；
playlist 无变化时按 1×、1×、1.5×、2× 封顶退避；一有新片段立即重置；
ENDLIST/VOD 不再刷新；支持 `CAN-BLOCK-RELOAD` 时下次可立即长轮询。
所有时间点都是绝对毫秒（`fetchedAtMs + intervalMs`），与系统时钟无关。

## 确定性

- 库内**从不**读取 `Date.now()` / 定时器 / 随机数；
- 所有输出数组都按稳定键排序（rendition id、MSN）；
- 诊断按内容去重；重复投递同一份 playlist 不会产生重复告警。

调用方需要在喂 playlist 时提供 `fetchedAtMs`，查询追赶计划时提供 `nowMs`。

## 开发

```bash
npm install
npm test          # vitest，测试里的 playlist 全部由代码生成
npm run typecheck
npm run build
```

测试覆盖：解析（key / byte range / MAP / PDT / SERVER-CONTROL）、
窗口滑动与乱序、缺口与序列跳变、片段身份冲突、EVENT/VOD/结束、
广告 discontinuity 对齐、刷新退避、追赶计划，以及同一输入乱序投喂结果一致。

## 许可证

MIT
