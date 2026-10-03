# hls-window-tracker

服务端使用的 HLS 直播**播放窗口跟踪库**。它只回答一个问题：*现在能播什么*。

- 不下载任何媒体或 playlist（播放器/下载器是你自己的）
- 不做界面、不做解码
- 负责解析、合并反复到达的 master/media playlist，并提供：
  - 每个 rendition 当前的**可播范围**
  - rendition 之间在哪里可以**对齐/切换**
  - 哪些位置是**确认缺失**的片段
  - 下一次应该在什么时候**刷新**
  - 从某个位置追到直播边缘的**追赶计划（catch-up plan）**

## 设计要点

- **窗口单调不退**：网络抖动时旧 playlist 可能比新的晚到。库会检测 out-of-order
  投递并拒绝，可播范围永不回退。
- **确认缺口（confirmed gap）而非猜测**：
  - reload 之间序列号跳跃（跳过若干 msn）→ 记录为 `sequence-jump` 缺口；
  - 同一份完整 playlist 窗口内部中间缺号、两侧都有片段 → 记录为内部缺口；
  - 普通滑窗从头部离开的旧片段**不会**被误报成缺失。
- **discontinuity 用 era（dseq）隔离**：直播中插广告时，广告段是独立的
  dseq 区域，时间戳从头算起也不会污染主时间线的可播范围与对齐点。
- **片段身份四要素**：两个片段只有在 `URI`、`byte range`、加密 `KEY`、
  初始化段 `MAP` 全部一致时才是同一个片段；任一不同都会给出能定位到
  playlist + msn 的诊断。
- **EVENT / VOD / 已结束直播**分别处理：EVENT 只在尾部增长（头不回缩）；
  VOD 与 `ENDLIST` 后不再调度刷新。
- **完全确定性**：库本身不读时钟、不用随机数。所有时间由调用方传入
  （`fetchedAtMs` / `nowMs`）。相同输入永远得到相同结果和相同顺序，
  与运行时刻、机器无关。仅有的刷新抖动由 playlist URI 哈希确定。

## 安装

```bash
npm install hls-window-tracker
```

需要 Node.js 18+（ESM）。

## 快速上手

```ts
import { HlsWindowTracker } from 'hls-window-tracker';

const tracker = new HlsWindowTracker();

// 每次下载完一个 playlist（master 或 media，顺序任意）就喂给它
const result = tracker.ingest(text, {
  uri: 'http://example.com/live/low.m3u8',
  fetchedAtMs: Date.now(), // 时间由你传入，库自身不读钟
});
// result.kind      -> 'master' | 'media'
// result.accepted  -> 旧/重复 playlist 会被拒绝（false）
// result.diagnostics -> 定位到 playlist、msn 的提示

// 然后按需查询
tracker.playable();      // 每个 rendition 现在能播哪一段、哪里确认缺失
tracker.alignment();     // rendition 之间在哪些点能对齐（按 dseq era 分组）
tracker.refreshPlans(Date.now()); // 下次刷新时间
tracker.catchUpPlan({ referenceRenditionId: 'v0', nowMs: Date.now() });
```

典型服务端循环：

```ts
const tracker = new HlsWindowTracker();

async function poll(uri: string) {
  const text = await download(uri);                 // 你的下载器
  const res = tracker.ingest(text, { uri, fetchedAtMs: Date.now() });
  for (const d of res.diagnostics) {
    log(d.severity, d.code, d.playlistUri, d.msn, d.message);
  }
  const plan = tracker.refreshPlans(Date.now());
  setTimeout(() => pollSoonest(plan), plan.nextFetchMs! - Date.now());
}
```

## API

### `new HlsWindowTracker()`

### `ingest(text, { uri, fetchedAtMs }): IngestResult`

自动识别 master / media 并合并。只有文本根本不是 HLS playlist 时才抛
`PlaylistParseError`；单行格式问题会收集为诊断而不是中断。

```ts
interface IngestResult {
  kind: 'master' | 'media';
  generation: number;      // 单调递增的更新序号
  accepted: boolean;       // media 被判定为旧/重复时为 false
  changed: boolean;        // 是否真的带来了新状态（用于刷新退避）
  diagnostics: Diagnostic[];
}
```

### `playable(): PlayableReport`

每个 rendition 当前可播的连续段集合，以及当前窗口内确认的缺口：

```ts
interface PlayableRendition {
  renditionId: string;            // v0, v1, a0, s0 ...
  uri: string;
  kind: 'variant' | 'audio' | 'video' | 'subtitles' | 'closed-captions';
  status: 'live' | 'event' | 'vod' | 'ended' | 'unknown';
  windowHeadMsn: number | null;   // 最新快照窗口头/尾
  windowTailMsn: number | null;
  playable: { fromMsn: number; toMsn: number; dseq: number }[];
  gaps: Gap[];                    // 确认缺失（含滑出前缘的跳号缺口）
}
```

### `alignment(): AlignmentReport`

按 discontinuity 序列号把时间线切成 `eras`。era 内优先用
`PROGRAM-DATE-TIME` 对齐；没有 PDT 时退化为 era 内相对时长位置对齐
（不假设不同 rendition 的 msn 相等）。

```ts
interface EraAlignment {
  dseq: number;                   // 广告段会落在它自己的 era
  mode: 'pdt' | 'sequence' | 'none';
  points: AlignmentPoint[];       // 每个点给出各 rendition 对应的 msn
  commonPlayable: Record<string, { fromMsn: number; toMsn: number }>;
}
```

### `refreshPlans(nowMs): RefreshReport`

给出每个 rendition 的下次拉取绝对时间（epoch ms）：

- 直播：约一个 target duration；有 PDT 时按末段真实结束时刻对齐；
- 连续无变化：指数退避（1.5x → 封顶 3x），避免空转狂刷；
- EVENT：按增长节奏；VOD / 已结束：`nextFetchMs = null`；
- 带 ±5% 由 URI 哈希确定的抖动，避免多码率同时打点。

### `catchUpPlan(options?): CatchUpPlan | null`

从起始 msn（默认窗口尾）沿参考 rendition 走到直播边缘，输出有序步骤：

```ts
type CatchUpStep =
  | { kind: 'play'; fromMsn; toMsn; dseq; at /* 各 rendition 对应 msn */ }
  | { kind: 'gap'; gap }
  | { kind: 'discontinuity'; msn; fromDseq; toDseq }
  | { kind: 'catch-live-edge'; targetMsn; at }
  | { kind: 'end-of-play'; msn }
  | { kind: 'wait'; delayMs; untilMs };
```

`maxWalkSegments` 可在积压过长时直接跳到距边缘 N 段。

### `getDiagnostics(): Diagnostic[]`

所有历史诊断，按 generation / uri / code / msn 稳定排序。诊断码包括：
`sequence-jump`、`window-slide`、`dseq-mismatch`、`same-msn-conflict`、
`event-window-shrank`、`stale-playlist`、`empty-media-playlist`、
`unparseable-line`、`master-variant-uri-changed`。每条都带 `playlistUri`
和（适用时的）`msn`。

### 解析器单独使用

```ts
import { parsePlaylist } from 'hls-window-tracker';

const parsed = parsePlaylist(text, baseUri);
if (parsed.kind === 'media') {
  // parsed.media.segments[].msn / dseq / pdtStart / byteRange / key / map
}
```

## 广告插播（discontinuity）行为

playlist 中出现 `#EXT-X-DISCONTINUITY` 时：

- 片段带 `dseq`，广告构成独立 era；
- `playable()` 的每一段都标注所属 dseq；
- `alignment()` 不会把广告内的点和主节目对齐；
- `catchUpPlan()` 在边界产生 `discontinuity` 步骤，时间戳重置不会算乱；
- 刷新节奏只看 target duration / PDT，不会因为插广告而频繁刷新。

## 开发

```bash
npm install
npm test          # vitest run
npm run typecheck
npm run build
```

测试样本全部由 `test/helpers/playlists.ts` 代码生成，不依赖网络或固定文件。

## 许可证

MIT
