# latency-bench

Measures how long a VoiceThere voice agent takes to answer, from the client's side. It
starts a session on your own project with `@voicethere/client/node`, speaks a counting phrase
into the microphone track, waits for the agent to echo it, and records four timings per turn.
The results use the same file format as the
[node-webrtc-rust vendor benchmarks](https://github.com/akirilyuk/node-webrtc-rust/tree/main/benchmarks),
so you can summarise and compare them with that project's tools.

## What it measures

A turn starts when the last audio frame of your clip has been written to the microphone track
("speech end"). All four numbers are in milliseconds, taken on one monotonic clock on your
machine, at the moment the voice-control message arrives.

| Metric                         | Starts                                | Ends                                                                            |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| `speech_end_to_final_ms`       | speech end                            | `user_speech_final` event with a non-empty text (the speech-to-text result)     |
| `final_to_reply_start_ms`      | that `user_speech_final` event        | first `agent_speaking_start` event after it (the agent starts talking)          |
| `speech_end_to_reply_start_ms` | speech end                            | the same `agent_speaking_start` event: the wait a caller feels                  |
| `tts_first_audio_ms`           | agent called `speak()` (server clock) | first reply audio sent, as reported in `firstAudioMs` of `agent_speaking_start` |

A metric is `null` when one of its events never arrived. The first turn of each conversation
is recorded as `cold` (new session, new connections), the later ones as `warm`.

VoiceThere's own end-to-end runs use the same events and the same start and end points. They
differ in two ways: their load client produces its clip with text-to-speech, while this tool
plays a recording you provide, and the load client stamps events with the wall clock instead
of a monotonic one.

The numbers include your network path to the VoiceThere region and the load on your machine.
Close other heavy programs, note the region in `--region`, and use a machine that stays
awake: if the host sleeps during a run, the tool prints `[host-suspended] result:
inconclusive`, lists the gaps in `meta.json` and exits with code 3. Do not use such a run.

## Prerequisites

- A deployed VoiceThere project whose agent answers every final transcript with the same
  words. A few lines with [`@voicethere/agent`](https://github.com/voicethere/agent) do it:

  ```typescript
  import { defineAgent, speak } from "@voicethere/agent";

  defineAgent({
    onUserSpeechFinal({ sessionId, text }) {
      speak(sessionId, `echo: ${text}`);
    },
  });
  ```

  Keep the agent free of other work (no model calls, no greeting) so the numbers show the
  platform and not your agent logic.

- A **client** API key (`vthc_…`) for that project, in `VOICETHERE_CLIENT_API_KEY`. It is
  never printed or written to the output files. See
  [voicethere.io](https://voicethere.io) for how to create one.
- The project id, in `VOICETHERE_PROJECT_ID` or `--project`.
- A 16-bit PCM WAV file (mono or stereo, any sample rate) of someone saying a counting
  phrase such as "one two three four five six seven eight nine ten", about 3 to 6 seconds.
  The example ships no recording; record your own or generate one with a text-to-speech tool
  whose licence you have. For example, on a machine with `espeak-ng` and `ffmpeg`:

  ```bash
  espeak-ng -v en -s 150 -w counting.wav "one two three four five six seven eight nine ten"
  ```

  The tool converts the clip to 48 kHz stereo and scales the loudest sample to -1 dBFS.

- Node.js 22 or newer and `npm ci` in this repository.

## Run

```bash
export VOICETHERE_CLIENT_API_KEY=vthc_...
export VOICETHERE_PROJECT_ID=<your project id>

npm run bench:latency -- \
  --clip counting.wav \
  --turns 10 \
  --conversations 3 \
  --region eu \
  --out results/my-run
```

| Option                | Default                             | Meaning                                                                      |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `--clip <file>`       | required                            | WAV file to speak                                                            |
| `--out <dir>`         | required                            | Output directory. The run refuses to start if it already holds a `raw.jsonl` |
| `--turns <n>`         | `10`                                | Turns per conversation                                                       |
| `--conversations <n>` | `1`                                 | Conversations, one after another (a new session each)                        |
| `--region <label>`    | none                                | Free text stored in `environment.json`                                       |
| `--project <id>`      | `VOICETHERE_PROJECT_ID`             | Project to call                                                              |
| `--api-base <url>`    | `https://sessions.voicethere.io/v1` | Session API                                                                  |
| `--model <label>`     | `default/default`                   | `stt/tts` label stored in each record                                        |
| `--turn-timeout-ms`   | `30000`                             | Wait for a reply before the turn counts as failed                            |

To use the example outside this repository, copy the folder and change the import in
`src/run.ts` from `../../../src/node/index.js` to `@voicethere/client/node`.

## Output

- `raw.jsonl`: one record per answered turn, with `vendor: "voicethere"`, `leg: "e2e"`,
  `transport: "webrtc"`, `phase`, `text: "counting-echo"`, `run` and the four `metrics`.
- `meta.json`: schema version, turns and conversations, failed turns, start and end time, and
  any host-suspend gaps.
- `environment.json`: operating system, CPU, Node.js and client versions, region.

No transcripts, session ids or keys are written.

## Summarise and compare

The summariser and compare tool live in the node-webrtc-rust repository:

```bash
git clone https://github.com/akirilyuk/node-webrtc-rust
cd node-webrtc-rust
node benchmarks/scripts/bench-vendors.mjs --summarize <your-out-dir>
npm run bench:compare -- benchmarks/results/<published-dir>/<run> <your-out-dir>
```

How the library numbers are measured is described in
[METHODOLOGY.md](https://github.com/akirilyuk/node-webrtc-rust/blob/main/benchmarks/METHODOLOGY.md).
Those runs call the speech vendors directly, so they leave out WebRTC and the VoiceThere
platform; this tool adds both.
