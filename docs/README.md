# cliply docs

the code has the detail — most files in `src/main/` carry long comments
explaining *why* they are the shape they are, and those comments are the
authority. these pages are the map: where things live, how the pieces fit, and
the handful of decisions that are not visible from any single file.

## start here

| page | what it answers |
| --- | --- |
| [architecture.md](architecture.md) | what the three processes are and what each one owns |
| [development.md](development.md) | getting a checkout running, the scripts, the test suites |
| [ipc.md](ipc.md) | every channel between the renderer and main, and what it carries |

## features

| page | what it answers |
| --- | --- |
| [transcripts.md](transcripts.md) | how subtitle downloads work, end to end |
| [updates.md](updates.md) | the two independent updaters — the app's, and yt-dlp's |

## shipping

| page | what it answers |
| --- | --- |
| [releasing.md](releasing.md) | building installers, cutting a release, what CI runs |
| [ffmpeg.md](ffmpeg.md) | what ffmpeg is used for, and what its license asks of us |

## when something breaks

| page | what it answers |
| --- | --- |
| [troubleshooting.md](troubleshooting.md) | the failures people actually hit, and what causes them |
| [analytics.md](analytics.md) | how to read the dashboards without being misled by them |

## also worth reading

- [`PRIVACY.md`](../PRIVACY.md) — the user-facing statement of what leaves the machine
- [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) — everything cliply ships that somebody else wrote
- [`binaries/README.md`](../binaries/README.md) — getting ffmpeg and deno into a development checkout

## the design notes

[`superpowers/`](superpowers/) holds the plan and spec for the issue-report
feature. they are a record of how that feature was designed, not a description
of how it works now — read the code for that.
