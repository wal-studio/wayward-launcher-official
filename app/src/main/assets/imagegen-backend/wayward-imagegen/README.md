# wayward-imagegen

## ImageStudio server 0.8.3: both compatibility naming orders

Server extensions are loaded from both `imagestudio-compatible-*` and
`*-compatible-imagestudio` mod folders. Existing extension behavior is unchanged.

## ImageStudio server 0.8.2: separate normal and animal image packs

`POST /api/custom-pack/build` includes only `illustrious/characters/` files and excludes animal interaction keys, even when cached under that directory. All situation and other workflow directories are excluded. `GET /api/custom-pack/capabilities` reports this scope before the game requests a build. The existing animal extension's `/api/animal-pack/build` remains the dedicated animal pack endpoint. Source images and existing numbered packs are preserved. Restart the core server after installing this version.

## ImageStudio 0.5.1: character-scoped cache reconciliation

`POST /api/image-cache/sync-character?character=hina` reconciles only that
character, preserves all other shards and backs up only the affected records.
`progress=1` returns the same NDJSON progress format as full-library sync.
The existing `/api/image-cache/sync` continues to reconcile the full library.
Neither endpoint deletes image files or clears valid entries. The UI calls
these operations cache initialization; this means rechecking file paths.

## ImageStudio 0.5.0: character cache files

Indexes are stored in `images/.image-cache_hina.json`, `.image-cache_mika.json`,
and the equivalent file for each character. Workflows share the character file
but retain their separate cache keys. Unattributable historical entries use
`.image-cache_shared.json`. Entries, prompts and hashes are preserved.

Startup reads the character files into the existing unified in-memory catalogue.
A completed generation rewrites only its character file, using a staged rename;
it does not serialize and overwrite every other character's index. This reduces
individual file size and write work, not the total amount of cache metadata.

The first startup migrates `.image-cache.json` and retains its exact original as
`.image-cache.json.legacy-<id>.bak` only after all character files were saved.
Stop all old image servers before switching versions. A broken index fails
loading rather than being replaced with empty data. Repair/sync support the
new files, preserve backups, and reject concurrent changes.

For an offline preview, run `bun src/splitImageCache.ts --config <config>`;
add `--apply` to migrate with the server stopped. The mod also includes
`Split_Image_Cache.cmd`. The WebP repair tool's dry run never migrates indexes.

## ImageStudio 0.4.2: WebP output and cache relinking

Use the mod's `Start_ImageStudio.cmd`. It installs the pinned sharp dependency
inside this server folder when needed and starts with `--require-webp`.
Finished renders use WebP quality 85, preserving image dimensions and alpha.
This is lossy encoding. Conversion failures preserve the PNG and report an
error instead of silently registering a PNG result. ComfyUI's own output
directory is separate and keeps the format selected by its workflow.

Startup and cache sync relink converted PNG/WebP paths. Moved images are matched
only by a unique full basename including timestamp, and a real RIFF/WebP header
is required. Unrelated files and ambiguous names are not guessed. The cache key,
prompts, hashes and generation settings are preserved; the index is backed up.
The mod's `Repair_WebP_Cache.cmd` also restores missing records from cache backups
when a readable WebP still exists. Stop the image server before applying repair.
Use `--dry-run` to preview. Offline pack scripts must be rebuilt separately.

## ImageStudio 0.4.1: multi-prompt sampler batches

The ImageStudio generation settings include `promptBatchSize` (1–128, default 1).
The bulk queue groups distinct consecutive requests with matching model, LoRAs,
dimensions and sampler settings into one sampler execution. Results are mapped
by output node and cached separately for each original scene. Normal one-prompt
requests still return one image. SDXL/Illustrious and Anima are supported.

Counts above 1 require the bundled `ImageStudioMultiPrompt` custom node. Run the
mod's `Install_ComfyUI_PromptBatch.cmd` to install or update the node, and
restart ComfyUI. Previous 1–16 nodes must also be updated. A missing node pauses
work without discarding the queue. Start this bundled server with the mod's
`Start_ImageStudio.cmd`; copying files into the game-root server is unnecessary.
OOM failures retry unsaved scenes at smaller batch sizes for that run; the saved
setting remains unchanged. CLI/config: `--prompt-batch-size`, `promptBatchSize`,
or `WAYWARD_PROMPT_BATCH_SIZE`. Two ComfyUI processes are not needed.

Draw Wayward's pictures on your own computer.

The game ships with a library of images. This program lets you add to it: it
watches for pictures the game wants but does not have, renders them through your
own [ComfyUI](https://github.com/comfyanonymous/ComfyUI), and serves them back.
You can also leave it running overnight to fill in the pictures your playthrough
is likely to ask for before you get there.

It is a small HTTP server and nothing else. It does not modify the game, it does
not phone anywhere, and it never runs another program.

---

## What you need

- **[Bun](https://bun.sh)** — one download, no configuration.
- **ComfyUI**, running, with a checkpoint installed. The shipped art was made
  with `waiIllustriousSDXL_v170` plus the `sdxl_lightning_8step` LoRA; anything
  else will work but will not look quite like the pictures you already have.
- A GPU with enough memory for that model. A render takes roughly five to
  fifteen seconds.
- **Three ComfyUI custom node packs**, installed through ComfyUI Manager. The
  shipped graph uses nodes from each, and without them ComfyUI will refuse it:
  - **ComfyUI Impact Pack** *(ltdrdata)*
  - **ComfyUI Inspire Pack** *(ltdrdata)*
  - **KJ Nodes for ComfyUI** *(kijai)*

Run `bun src/cli.ts doctor` to check all of this at once — see below.

## Running it

```
bun src/cli.ts
```

Then open the game and go to **Settings → Image generation**. On *Automatic* it
finds the server by itself and the status turns to "connected".

That is the whole setup. The game will now draw anything it does not already
have, while you play.

### If ComfyUI is somewhere else

```
bun src/cli.ts --comfy-url http://192.168.1.50:8188
```

### If port 8189 is taken

```
bun src/cli.ts --port 9000
```

Then set **Specific address** in the game's settings to `http://127.0.0.1:9000`.
The server will not quietly move to another port — a server the game cannot find
looks exactly like a broken one.

### Playing from your phone

```
bun src/cli.ts --host 0.0.0.0
```

Serve the game from the same machine (or open it on the phone from a file) and
the game finds the server at that machine's address on its own. Pages on your
own network are allowed to call it when it is bound this way — a page anywhere
else still is not. Use plain `http://` on the phone: a page loaded over
`https://` is not allowed to fetch from an `http://` server.

If nothing connects, the machine's firewall is the usual reason: allow `bun`
on private networks.

`bun src/cli.ts --help` lists every option.

## When pictures do not appear

```
bun src/cli.ts doctor
```

It answers, in order, the questions you cannot answer by looking: is ComfyUI
reachable, are the three node packs installed, can ComfyUI see the checkpoint
and LoRA under the exact filenames configured, and — the only proof that
counts — does one test render actually come back. Each failure names what to
change.

The commonest cause is a **checkpoint or LoRA filename that does not match**.
ComfyUI does not reject the whole job for that: it drops the part of the graph
that saves the picture, keeps the rest, and reports success about two
milliseconds later having rendered nothing. `doctor` catches it before you
spend an evening on it.

If it all passes and the game still shows no picture, check **Settings →
Image generation** in the game — it needs to be on *Automatic*, or *Specific
address* pointing here.

---

## Making pictures ahead of time

In the game: **Settings → Image generation → Make pictures ahead of time**.

Pick who, how many, and start it. It works through the list most-likely-first,
so stopping early still leaves you with the pictures you were actually going to
see. You can keep playing while it runs — anything you look at is drawn first.

The whole space is tens of thousands of images, which is days of GPU time. The
panel tells you how long it thinks it will take. Leaving it overnight is the
intended use.

Progress survives a restart. If the machine reboots, it picks up where it left
off, paused, waiting for you to say continue.

---

## Reviewing what it made

Open <http://127.0.0.1:8189/> while the server is running.

One picture at a time: **Keep** (J) or **Redo** (K). Redo can carry a note about
what is wrong with it. Your verdict outranks anything automatic — if you say a
picture is wrong, it is wrong.

---

## Sending pictures back

If you make images you think belong in the game, you can offer them:

```
curl -X POST http://127.0.0.1:8189/api/contrib/export \
  -H 'Content-Type: application/json' \
  -d '{"onlyKept": true, "contributor": "your name"}'
```

That writes a folder under `<state-dir>/contributions/`. **Look through it
before you send it** — it contains your own images, including anything you
generated for yourself.

A bundle carries the pictures, the prompt each one answers, your verdicts, and
which model settings were used. That last part matters: an image made with a
different checkpoint is a different look, not a better or worse render.

Sending a bundle is you offering the images for use in the game.

---

## Where things go

```
<images-dir>/                       default ./images
  .image-cache.json                 which picture answers which request
  illustrious/characters/<who>/     the pictures
  videos/                           if you enabled video
<state-dir>/                        default <images-dir>/.state
  image-hits.json                   how often each picture has been shown
  review-progress.json              your verdicts
  batch/                            overnight queues, so they survive a restart
  contributions/                    export bundles
  cache-misses.jsonl                what the game asked for and did not have
```

Nothing is written outside these.

---

## Video

Off unless you turn it on, because it needs a workflow and models this does not
ship:

```
bun src/cli.ts --wan-workflow ./my-wan-i2v-workflow.json
```

Export an image-to-video workflow from ComfyUI in **API format**. The bundled
node ids are expected; a differently-built workflow will need its ids remapped,
and the server says which node it could not find rather than failing obscurely.

---

## Safety

It listens on `127.0.0.1` only — nothing outside your machine can reach it —
unless you pass `--host 0.0.0.0`, which opens it to every device on your
network. It runs no other programs, and writes nowhere but the folders above.

It does **not** ask who is calling. Any page open in your browser can reach a
server on your own machine; that is true of every local server and no header
check can distinguish one local page from another. What is bounded instead is
the damage: there are caps on how many images an hour it will draw, how deep the
queue can get, and optionally how large the library may grow
(`--max-disk-gb`). Deleting images is off unless you pass `--allow-delete`.

If you would rather it not be reachable at all while you are not using it, stop
it.

---

## Modifying it

It is plain TypeScript with no build step — edit a file, restart, done.

```
src/cli.ts             arguments and startup
src/config.ts          every setting, and where it comes from
src/server.ts          wiring
src/routes/            the HTTP endpoints
src/comfy/workflows/   the ComfyUI graphs — change these to render differently
src/cache/             the picture index
src/batch/             the overnight queue
ui/index.html          the review page
```

`src/comfy/workflows/index.ts` is the interesting one: it builds the node graph
sent to ComfyUI. Changing the sampler, adding a LoRA, or swapping the model
happens there or through the matching command-line options.

Run the tests with `bun test` from the repository root, or
`npx vitest run packages/wayward-imagegen/test/`.

The prompts themselves are **not** here — the game builds those and sends them
over. This program decides how a prompt becomes a picture, not what the picture
should be of.
# ImageStudio 서버 0.8.0의 NovelAI 연결

게임의 `이미지 스튜디오 → 이미지 생성 방식 지정 → NovelAI (NAI)`에서 토큰과 생성값을 저장합니다. NAI를 선택하면 ComfyUI 없이 일반 생성·대기열·검수 승인을 처리합니다. 기존 게임이 엔진 준비 상태로 사용하는 health의 `comfyui` 필드는 NAI 준비 시에도 `connected`를 반환하며, 실제 엔진은 `imageProvider: "nai"`, `comfyuiRequired: false`로 구분합니다. health의 토큰 설정 유무는 인증 성공을 의미하지 않으므로 `/api/nai/check`로 따로 확인합니다.

API 토큰은 설정 응답에 포함하지 않습니다. `PUT /api/generation/settings`의 빈 `naiToken`은 기존 토큰을 유지하고 `naiTokenClear: true`로 삭제합니다. NAI 전용 프롬프트와 모든 생성값을 캐시 해시에 반영합니다. 사용자 상태와 토큰은 배포 대상에 포함하지 마세요. 자세한 사용법은 모드 상위의 README.md에 있습니다.

