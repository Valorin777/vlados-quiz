# app/src/host — game driver, player API, view models

Framework-free TypeScript; runs in the browser and in Node 22 (bots/tests). Screens consume
**only** the view models from `views.ts` (`PlayerView`, `TvView`, `AdminView`) and call the two
classes below. Nothing here touches the DOM.

## Phones

```ts
const player = new PlayerSession({ db, uid: user.uid });  // gameId from config/current
await player.start();                                        // then player.whenReady() if you need `me`
player.subscribe(() => render(player.view()));             // also re-render on a ~250 ms ticker (timer)
await player.join(name, avatarJpeg, thumbJpeg);             // {ok} | {ok:false,error:'bad_name'|'closed'|…}
await player.answer(view.question.i, { t: 'choice', id }); // {ok} | {ok:false,error:'late'|'closed'|'kicked'|'offline'|'invalid'}
await player.react(0);                                      // throttled: 1 per 3 s, 4 per minute
await player.rename(name); await player.setAvatar(avatar, thumb);
```

`start()` returns once the game listener runs; the own player doc is read in the background and
retried until the server answers (`screen` stays `loading` meanwhile — never `join` for a guest who
already joined). `join()` is idempotent: one write per game however often it is called; a server
ack switches the view to `lobby` at once; `'offline'` means no answer yet while the write stays
queued (the view still flips when it lands, calling again just keeps waiting); a create refused
because the doc exists adopts it. `joining` is true while that write is on its way.

`view().screen` says what to show: `loading | no_game | join | join_closed | kicked | lobby | intro |
question | answered | time_up | reveal | board | final`. The join form must still check the name
with `checkedName()` (grapheme + UTF-16 limits).

## TV and admin pages

```ts
const host = new Host({ db, uid: admin.uid, preferred: true /* TV */ });
await host.start();                        // game from config/current; follows newGame
host.subscribe(() => render(host.tvView())); // or host.adminView()
await host.command({ type: 'advance', phaseRev: view.phaseRev }); // {ok,phaseRev} | {ok:false,error:'stale'|'invalid'|…}
await host.stop();                         // on page unload: frees the lease at once
```

Every admin page runs a `Host`. The one holding the lease (`games/{g}/private/host`, TV preferred)
performs the timed transitions; the others take over when it expires (15 s during a question).
`AdminView.can` tells which commands make sense right now.

## Data (see model.ts)

- `games/{g}` — public doc (phones read only this). Written by one transaction per phase change;
  `answered` at most every max(5 s, limit/3, 100 ms × players) (≤ 3 per question), `players` at most
  every min(90 s, max(15 s, 1 s × players)) — every version is a read on every phone.
- `games/{g}/private/totals` — rounds with frozen questions, pause history and every counted answer
  with its frozen result (compact rows). A restarted host continues from it.
- Scoring uses server times: `answer.at − openAt`, pauses excluded, clamped to `[0, T]`.

## Video questions: the watch stage (shared/engine/watch.ts)

Videos play ONLY on the TV, with sound; phones never play them (whatever «на телефонах» says —
`mediaNow` gives phones the poster only, the admin editor shows a note instead of the switch). A
question whose main media is a video does not start its answer timer with the video. Inside phase
`intro`: title splash (`introMs`) → the TV plays the video with sound (phones: «Смотри видео на
большом экране» + a bar over `round.media.videoMs`, no options, no timer; answers are refused by
`openAt`) → «Варианты появятся через 3…2…1» → the options with the full timer.
The round starts with `openAt = introAt + introMs + window + 3 s`, window = video length from
`startAtS` + tail — the fallback: + 5 s when a TV is on air (`tvOnAir(lease)`: a preferred page holds
the lease; it reports the end), + 1 s without one (nobody would report it; `runStep` reads the lease
and passes `StepCtx.tv`). Unknown duration: 3 min with a TV, 30 s without. The TV reports the
video's end (`command({ type: 'watchEnd', phaseRev })`; also the admin's «Видео досмотрели — старт»
and the TV's Space), which pulls `openAt` in to now + 3 s and `endsAt` with it; the time limit and
the scores count from the new `openAt`. The window is frozen in `private/totals` (`PrivRound.watch`
= { ms, videoMs }) and published as `round.media.watchMs` / `videoMs`; the video starts at
`openAt − 3 s − watchMs`, so a pause (resume shifts `openAt`) moves it too. `watchView()` gives the
stage to screens. `npx tsx tools/watch-dev.ts` checks it on DEV (rules, host, PlayerSessions);
`npx tsx tools/video-phone-dev.ts [--tv] [--freeze 6:40]` walks a real WebKit phone through it.

**A late host.** The host switches intro → open at `openAt`; when it is late (the organizer's report,
2026-09-23: the admin page was the only host, its tab in the background, the tick came ~20 s late
and the guests never saw the options) the phones do not wait: `phoneGame()` treats an unpaused
intro past `openAt` as open (options + full timer exactly at `openAt` on the phone's clock), the
rules accept answers in that intro from `openAt − 0.5 s` (`windowOpen`), `answersLive()` makes the
host load and count them, and a host that wakes up after `endsAt` goes intro → open → locked in one
tick and reveals them scored from `openAt`. Pages pass `wake: workerWake()` (host/wake.ts): a
worker's ticks keep a hidden admin/TV tab driving on time where the page's timers are throttled.
The admin «Эфир» warns «ТВ не подключён — видео никто не увидит» during a video round without a TV,
and «игру ведёт этот пульт» whenever it drives the game without a TV.

**The options appear once.** A phone's stage only moves forward inside a round: `PlayerSession`
remembers the round it has shown open (`PlayerViewInput.opened`), and `phoneGame()` keeps it open
while its server-clock estimate steps back by up to `OPEN_LATCH_MS` (1.5 s — a better clock sample
right after openAt used to bring the 3-2-1 back and replay the options' entrance); the answer
precheck then counts from openAt (the server decides). Not while paused. Entrances run before paint
(`useEntrance` / TV `useBeat` are layout effects) and do not restart when the liquid governor drops
to tier 0; the TV's option tiles stay invisible until their own pop. `PubMedia.w/h` (media meta)
size the frames before a picture decodes, so nothing below it jumps.

## «Стоп-экран»: the hold (HostCommand 'hold' / 'unhold')

The organizer's «Сказать всем» (admin «Эфир»: «Показать» and every quick text) is ONE transaction,
phaseRev-guarded (the card retries a 'stale' on the fresh phase — it must stop NOW): `banner` = the
text AND `pause = { at, remainingMs, reason: 'hold' }`, in ANY phase (lobby, intro and its watch
stage, open, locked, reveal, board, final). `remainingMs` is what the running timer had left:
intro/open → to `endsAt` (exactly like a pause), locked/reveal/board/final → to the next timed
transition (lock grace, auto-advance), 0 when none. While held `nextDeadline()` is null, so no host
— the TV in a background tab, an admin page that took the lease over — moves anything: the hold is
state in the game doc, not in a page. start / advance / reveal / skip / pause / jumpTo / end /
resetScores are refused ('invalid'; `AdminView.can` agrees); a second 'hold' only changes the text
(«Сменить текст»); a hold over an admin pause keeps its start and time left. 'unhold' (and 'resume')
ends it: intro/open shift `openAt`/`endsAt` by the hold (a video's start moves with them, so it
plays on from the same frame), locked shifts `lockedAt`, reveal/board/final shift `phaseAt` — every
timer continues with the time it had left; the text goes. A pause record goes to `private/totals`
only for intro/open/locked (scoring excludes the hold). `isHeld(game)`, `holdView()` →
`TvView.hold` / `PlayerView.hold` (`pause` is set too, reason 'hold', so scenes treat it as a pause).

- TV (`TvShow`): only the text, full screen, chrome letters on the dark ground (`HoldScreen`).
  The scene stays mounted underneath, hidden and frozen: `audio.hold(true)` suspends the
  AudioContext (and keeps it suspended when the tab is hidden and shown again, or a key unlocks
  audio), `silenceMedia(true)` pauses + mutes every <video>/<audio> (and stops anything that tries
  to play), GSAP's global timeline is paused, the liquid engine pauses once the screen is covered,
  reactions are only marked seen (none fly in afterwards). Released: everything resumes and the show
  fades back in. Space on the TV releases it only on a second press. DEV: `__tvSound()`.
- Phones: «Пауза — смотри на экран» with the text (small); the screen underneath stays mounted
  (drafts survive), `canAnswer` false, reactions off (`PlayerSession.react` refuses, the precheck
  says 'closed'), audio held.

`npx tsx tools/hold-dev.ts` checks it on DEV end to end (TV page + admin panel + a WebKit phone):
lobby, the video watch stage (paused at its frame, silent through a tab switch, plays on), an open
question (exactly the same time left), the reveal with the TV's lease expiring into an admin
takeover (nothing resumes).

## Reveal media (the picture / video after the right answer)

`reveal.media` (with `w/h`, a video's `posterId`). The TV brings it in with the mercury droplet from
the right answer — a video right after the right option lights up, a photo a few seconds later —
into a frame of its own proportions (blurred fill, no bars), the text after the answer next to it.
A video plays WITH SOUND on the persistent unlocked element the moment the droplet splashes open
(muted fallback if refused); if the host presses on while it plays, a copy of the layer fades out
with the sound over the board (`tv/media.ts` → `videoOutro`). Phones: a photo when «на телефонах»,
a video's poster always, with «▶ на большом экране» (videos are TV-only). The TV warms every
question's and reveal's file (and posters) into its cache when it starts. The editor preview plays
the reveal video in its TV frame (muted, 🔊 button); the «Автопилот» (and so «Прогнать игру») keeps a
reveal on air for the picture / the whole video (`revealHoldMs`, see below) and the rehearsal, at
×2/×4, holds the clock before the board until the TV has played it.

## The video after the final (shared/engine/finale.ts)

The organizer's request (2026-09-23): after the final and the winners, play the video from the party
folder — beautifully, with its own soundtrack. Final step 6, after the mosaic (step 5), when
`Settings.finaleVideo` is not 'off': 'builtin' (default) — `app/public/finale.mp4` (byte-identical to
`assets/finale-original.mp4`, 464×848, 14.93 s) + `finale-poster.jpg` (its first frame), served next
to the page (`/vlados/finale.mp4`); 'custom' — an uploaded video (`finaleMediaId`, the normal media
upload in admin «Настройки» → «Видео после финала»; the built-in one while it has no video file).
`lastFinalStep(settings)` is 6 (5 when off). **5 → 6 starts by itself** (organizer, 2026-09-23):
exactly `FINALE.autoMs` (5 s) after the mosaic («С днём рождения, Владос!») came on, whatever
`autoAdvance.finalStepS` says — `finaleAutoAt()` = step 5's phaseAt + 5 s is the host's deadline
(`nextDeadline`), so a restarted host or a lease takeover keeps the moment (late: at once, once), a
«стоп-экран» freezes it (released: the rest of the 5 s), «Не показывать» schedules nothing.
'advance' (the admin's «▶ Финальное видео», TV Space) starts it earlier. `AdminView.finaleVideoIn`
= { ms, at, held } drives «само начнётся через N с» under the «Эфир» button. Step 6 is the last,
nothing is scheduled after it.
`final.video` = { at: phaseAt + `FINALE.leadMs`, ms, id?, poster?, w, h } (`finaleVideoPub`); a hold
shifts phaseAt when released, so `at` moves with the paused video. During the mosaic `next.media`
carries an uploaded video's poster (phones prefetch it). `finaleView()` → `TvView.finale` /
`PlayerView.finale` (no video id for phones): 'gather' until `at`, 'play' until at + ms +
`FINALE.tailMs`, then 'after'.

- TV (scenes/Finale.tsx, tv/finale.css, tv/finale.ts): the mosaic's selfies flow into one point, a
  mercury droplet (Emerge) swells out of it and splashes open into a frame of the video's own
  proportions over a blurred, glowing copy of its poster (blurred once into a small picture,
  `softPoster`, no CSS filter under the video); the video plays on the persistent unlocked
  element at volume 1 with its sound (the TV's M key still mutes). `audio.duck(true)` fades the
  game's sound out first and keeps it out; at 'ended' the frame melts away, a fresh mosaic with
  «С днём рождения!», confetti and the lobby pad comes back (`duck(false)`). «Стоп-экран»: paused +
  muted where it stood, plays on from the same frame. A late droplet (throttled page, ×4) → the video
  starts on the clock; a reloaded TV joins at `posMs` (after the end: the mosaic). «Начать шоу»
  loads the built-in clip into memory (`preloadBuiltinFinale`); an uploaded one is warmed with the
  show's media. DEV demo: `#/tv?env=dev&demo=final-5` → Space, `final-6`, `final-6-custom`, S toggles
  the stop-screen.
- Phones (player/Finale.tsx): «Смотри на экран», the poster with a 🎬 badge, a thin bar following the
  video; then their final screen again (fixtures `final-6`, `final-6-after`).
- «Прогнать игру»: the mosaic stays 5 s (the host's own start, as on the night), then the whole video (with sound when «Звук» is on;
  ×2/×4 play it faster) and `finaleAfterMs` of the mosaic.

## «Сюрприз»: a question interrupted by a video (shared/engine/surprise.ts)

The organizer's request (2026-09-25): on the last question («Кто лучше всех поздравил Владоса») —
while the options are on screen, strictly before everyone answered and before the answer — the TV
«breaks down», goes pure black for 2 s and plays the video from the party (the built-in one:
`app/public/surprise.mp4`, byte-identical to `assets/surprise-original.mp4`, 576×1024, 263.6 s,
+ `surprise-poster.jpg`, its first frame); when it ends, the question's reveal, and ~10 s later the
final: after the video the quiz is over. Per question: `Question.surprise = { on, src: 'builtin' |
'custom', mediaId?, afterS }` — admin «Вопросы» → the question → card «Сюрприз-видео» (toggle
«Прервать этот вопрос видео», the video, «Через сколько секунд после появления вариантов», default
4 s (as the demo showed it, organizer 2026-09-26; a question keeps the value it has), ≥ 2 s, < the
time limit; the list shows «🎬 сюрприз»).

- Round start: `Round.surprise = { afterMs, ms }` frozen (PrivRound.surprise; an upload's length
  from its media meta). Open: `nextDeadline` = min(endsAt, openAt + afterMs) — the all-answered
  early lock is OFF for such a round; admin «Показать ответ» there starts it at once.
- The interrupt = phase 'locked' with lockedAt = its start and **endsAt pulled in to it**: the rules
  (unchanged) accept answers until endsAt + 2 s (those on their way count with their own speed —
  scoring uses the time limit, not endsAt); later ones are refused, PlayerSession says 'late'.
- Published only once it runs, in `next.surprise = { at, ms, id?, poster?, w, h }` (the rules
  whitelist the keys of the doc and of `round`; `next` is a free map — no rules deploy). A pub/next
  refresh never writes it (`keepSurprise`: the game doc and totals arrive through two listeners, a
  refresh in between put the stage back by a released hold). `surpriseView()` → `TvView.surprise` /
  `PlayerView.surprise`: glitch (SURPRISE.glitchMs 2.6 s) → black (2 s) → play (from `videoAt`)
  → after (the video should have ended + tailMs 12 s).
- The end: the TV's 'ended' → `command({ type: 'surpriseEnd', phaseRev })` (also «Досмотрели — к
  ответу» in «Эфир», TV Space — twice while > 8 s are left), or the fallback lockedAt + lead + ms +
  tail → the normal reveal. From that reveal the host goes to the final after SURPRISE.toFinalMs
  (10 s; «Финал»/advance earlier) — no board, the remaining questions are not played. 'skip' during
  it skips the question like any other.
- Everything is derived from stored lockedAt: restart-safe, once (phaseRev), lease holder only;
  «стоп-экран» shifts lockedAt when released — the TV's video plays on from the same frame.
- TV (screens/tv/surprise): `breakdown.ts` — freeze-frame hitch, RGB split, tearing slices (the
  liquid through a WebGL pass over a snapshot of the liquid canvas, the DOM through static copies
  clipped to the same bands), datamosh blocks, pixel-sort smears, shake, static, the chrome breaking
  into mercury beads, a CRT power-off (line → dot) with its sound (`audio.breakdown`: bit-crushed
  buzz, static, pitch-drop power-down); `SurpriseLayer.tsx` — the black, the video on the
  persistent unlocked element at volume 1 over a live blurred copy of itself, the melt into mercury
  over the reveal. The question underneath stays as it was (timer frozen, no «Время вышло»). The
  built-in video goes whole into memory as soon as a question has it (progress on the «Начать шоу»
  screen, neutral words). DEV demo: `#/tv?env=dev&demo=surprise` (`&vms=12000` ends it early),
  `demo=surprise-end` (8 s before the end → the melt).
- Phones (player/Surprise.tsx): ~1 s glitch of their screen (RGB split, static, vibration), black,
  then «👀 Смотри на экран» (dark in either theme, no poster); answering off; the normal reveal after.
  Fixtures `surprise-question`, `-glitch`, `-black`, `-watch`, `-watch-late`, `-reveal`, `-reveal-late`.
- «Прогнать игру»: the whole sequence (with sound when «Звук» is on); the interrupt is a mark of its
  own — → from the question shows the breakdown, → again skips the video to the answer.
- `npx tsx tools/surprise-dev.ts [--base http://localhost:5181/] [--shots]` checks it on DEV end to
  end: WebKit TV + phone, 3 bots (one before the interrupt, two after — refused by PlayerSession and
  by the rules), the video from memory with sound, a hold during it, 'ended' → reveal → final.

## «Автопилот»: the show runs by itself (shared/engine/showTimings.ts)

The organizer's request (2026-09-26): «всё должно быть автоматизировано, чтобы я мог просто
контролировать; тайминг точно такой, как в демке». He presses «Начать игру»; the host does the rest
with exactly the pace of «Прогнать игру» — ONE timings module (`SHOW`) for the live host and the
rehearsal. `Settings.autopilot`: undefined (every settings doc written before it, PROD included —
its autoAdvance numbers are all null) = ON, `autopilotOn()`; false = the organizer's button for every
step, plus the old optional `autoAdvance` numbers.

| step (from the stored phaseAt) | hold |
|---|---|
| intro → options | `Settings.introMs` (4 s) — the engine, as before |
| options → lock | the time limit / everybody answered (+ allAnsweredDelayMs) — the engine |
| lock → answer | lockMs + the host's grace (1.5 + 2 s) — the engine |
| answer → board | 9 s; with a text after the answer 12 s; with a photo 16 s; with a video: 2 s after the TV reported its end (never before 9 s), fallback 9 s lead (it comes after the right answer) + the video (from startAtS; unknown length: 30 s) + 4 s |
| board → next question (or the final) | 7 s |
| «Сюрприз» | 4 s after the options (default `afterS`), the video, the TV's 'ended' → the answer, 10 s → the final (always, as before) |
| final 0 drumroll → 3rd → 2nd → 1st → Vlados → the mosaic | 4 / 4.5 / 4.5 / 7 / 9 s |
| the mosaic → the video after the final | 5 s (`FINALE.autoMs`, always, as before); the video step is the last |

- `autoHoldMs(state, round, settings)` is the hold out of reveal / board / final (ms after phaseAt, or
  null); `nextDeadline()` (engine, host, rehearsal) and the admin's countdown both use it. The photo /
  video reveal hold is frozen when the round starts (`Round.revealHoldMs` → `PrivRound.revealHoldMs`:
  a host restarted mid-reveal has no media index yet); a text / plain answer is read from the frozen
  question. So: lease holder only, once (phaseRev-guarded transactions — a second host's tick finds
  nothing), restart-safe and late-safe (late: at once, once, the next hold from then), a
  «стоп-экран» freezes it (released: phaseAt moves, the time left runs), the admin pause freezes a
  question as before.
- The reveal video's end: the TV's 'ended' (RevealMedia → `command({ type: 'revealMediaEnd',
  phaseRev })`, one retry) stores `Round.revealEndMs` = ms after the reveal began (PrivRound too; a
  hold shifts phaseAt, so it moves with it) — no phase change, phaseRev stays. The hold out of the
  reveal becomes `revealAfterEndMs()` = min(frozen hold, max(9 s, revealEndMs + 2 s)): the board 2 s
  after the video, never before the plain 9 s, never after the clock hold (the fallback for a TV that
  reports late or never). Only in the reveal of a round whose reveal media is a video (not a
  «Сюрприз» round, not held); the first report counts. The rehearsal's TV reports it too, at
  `revealVideoStartMs(q)` (when the droplet lands: choice 9.2 s, number 7.4 s, ordering 6.1 s +
  0.32 s per item) + the video's length (unknown length: no report, the clock hold) — its board
  comes when the live one does (E2E, ordering of 4, 7 s clip: live 16.5–16.8 s, rehearsal 16.4 s).
- `AdminView.autopilot = { on, next: { kind: 'board' | 'question' | 'final' | 'step', n, ms, at, held } }`.
  «Эфир»: the switch «Автопилот: вкл/выкл» at the top; the big button reads «Таблица через 6 с»,
  «Вопрос 4 через 3 с», «3-е место через 4 с», «Финальное видео через 5 с»… and pressing it is the
  same 'advance' — the step now, the next countdown from then. Pause / +15 с / skip / «Сразу к
  финалу» / «Сказать всем» as before. «Настройки» → card «Автопилот» (the switch and the table in
  words); the «Время» card shows the autoAdvance chips only while it is off.
- DEV tools that drive the show by hand (hold-dev, surprise-dev, watch-dev, swarm,
  tests/host.dev.test.ts, `e2e-live --manual`) pin `autopilot: false` in their content.
- Tests: `autopilot.test.ts` (a whole game by itself, exactness, holds, skip, restart, on/off, the
  reveal video's report), the admin simulator in `screens/admin/demo/sim.test.ts`.
- E2E on DEV exactly like the night: `npm run e2e:local` (tools/e2e-live.ts) presses only «Начать
  игру» and checks every transition's pace (±1.5 s) through the watch video, a photo and a video
  after the answer, the «Сюрприз» (its own short clip) and the final to the end of the video after
  it, phones at every stage; `npm run e2e:local -- --manual` runs it with the autopilot off.

## «Прогнать игру»: the rehearsal (rehearsal.ts)

`simulate({ content, media })` plays the current content (enabled questions in order) through the
real `step()` — ticks, commands, the watch stage (the TV «reports» a video's end after its known
length) — with the «Автопилот» on (whatever the draft says): the simulated organizer presses only
«Начать игру», every other step is the host's own tick, exactly like the night. 24 fake guests (one of them Vlados, one «Ты») whose answers are deterministic and
realistic (≈60 % right, varied speeds; every other question everybody answers → early lock). The
result is a timeline of GameDoc/totals frames; `snapshotAt(tl, t)` / `playerInputAt(tl, t)` feed
`buildTvView` / `buildPlayerView` at any virtual time, `markAt` / `positionAt` / `nextMark` /
`prevMark` / `remapTime` drive the chips. Pure: no clock, no randomness, no Firestore. The admin page
`#/admin/rehearsal` (screens/admin/rehearsal) shows the real TvShow + PlayerShell on a virtual clock;
it reads admin/content and media only.

## Deviations from docs/firebase.md

- The lease lives in `private/host`, not in `games/{g}.host` (renewals would cost every phone a read).
  Idle lease (nothing scheduled): 30 s, renewed every 20 s.
- The reveal waits `lockMs + 2 s` after the lock (answers are accepted until `endsAt + 2 s`).
- While an open question is paused, the public `round.endsAt` is pushed 30 min out so answers keep
  being accepted; `TimerView` shows the frozen time. Resume moves `openAt`/`endsAt`.
- `round.i` is never reused inside a game (`resetScores` continues the count), so answer ids stay
  unique without deleting answers. `round.n` is the 1-based number people see (rules updated).
- `reveal.me[uid]` also has `acc` / `cl`; `final.me` (everyone's rank) only from step 3; podium rows
  carry `rank`; `final.video` at step 6 (the video after the final). Admin `rename` allows duplicate names (players cannot list others anyway).
- A new ordering round is re-shuffled with secret entropy (`StepCtx.shuffleSeed`, a fresh
  crypto-random number per transaction): the engine's seed is public and its shuffle invertible.
- Answers whose payload does not fit the frozen question (`answerFits`) are ignored everywhere.
- `pub.maxPlayers` is published for the join rule; `PlayerSession` queues owner writes of
  players/{uid} (rename, selfie, clock probe) ≥ `FB_LIMITS.playerWriteGapMs` apart, as the rules demand.
- Media of frozen rounds is resolved too (a question deleted mid-round keeps its media on air).
- `next.surprise`: the «Сюрприз» stage on air (see above) — the only non-prefetch field of `next`.
- Load/resilience: `npm run swarm -- --bots 40 --chaos` (tools/swarm.mjs) plays the template game with
  bots on DEV, checks scoring/ranks/leaks/rate limits/stale phases and meters reads/writes.
