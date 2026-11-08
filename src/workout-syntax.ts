/** The Intervals.icu structured-workout text format, served as an MCP resource.
 *
 *  Workout steps are written as plain text, not JSON: put this syntax in the
 *  `description` of a WORKOUT event or a library workout and Intervals.icu
 *  parses it server-side into a structured workout - training load, zone
 *  distribution and device sync all follow from it. A description the parser
 *  does not recognise is kept verbatim as free text, with no load and nothing
 *  to push to a head unit, and nothing in the API response says so. Worse, a
 *  single unrecognised *line* is dropped from an otherwise good workout, which
 *  shortens it silently. Hence this reference: the failure mode is invisible,
 *  so the syntax is worth getting right the first time.
 *
 *  Every rule and every example below was round-tripped through the live
 *  Intervals.icu API on 2026-10-16 - written as a description, then read back
 *  from `workout_doc` to see what the parser made of it. Where the forum
 *  documentation and the parser disagreed, the parser won and the rule here
 *  records what it actually did.
 */
export const WORKOUT_SYNTAX = `# Intervals.icu workout syntax

Plain text that Intervals.icu parses into a structured workout. Put it in the
\`description\` field of a WORKOUT event (create_events / update_event) or of a
library workout (create_workout / update_workout). Do not repeat the workout
title inside the description - that is the \`name\` field.

A line the parser cannot read is DROPPED, silently and on its own: the rest of
the workout is still built, just missing that step. Nothing in the response
flags it. Check \`moving_time\` and \`icu_training_load\` on the way back: if the
duration is shorter than the steps you wrote, a line was thrown away.

## Shape

Section headers with step lines under them. Step lines start with "- ".
Section headers are free text; conventional names are Warmup, Main Set and
Cooldown.

    Warmup
    - 10m ramp 45-65%

    Main Set 4x
    - 5m 105%
    - 3m 50%

    Cooldown
    - 10m 55%

## Repeats

Two forms, and the whitespace around them is part of the syntax.

A trailing \`Nx\` on a section header repeats the steps under it N times:

    Main Set 4x
    - 5m 105%
    - 3m 50%

A bare \`Nx\` on its own line does the same for an unnamed block. It needs a
blank line BEFORE it, its steps must follow IMMEDIATELY on the next line, and
the block ends at the next blank line:

    Warmup
    - 10m 50%

    3x
    - 30s 110% 100rpm
    - 1m 50%

    Cooldown
    - 5m 50%

Three ways to get this wrong, all silent:

- \`- 3x\` with a dash is never a repeat. It is read as a step line, fails to
  parse, and is dropped - leaving the steps under it to run once.
- A blank line between \`3x\` and its first step breaks the block the same way:
  the \`3x\` is dropped and the steps run once.
- A section header does NOT close a block. Without a blank line after the last
  step of the repeat, the following section's header is swallowed and its
  steps are pulled inside the repeat.

## Step length

Time:      \`30s\`  \`10m\`  \`1h\`  \`1h30m\`  \`5m30s\`
Distance:  \`400mtr\`  \`5km\`  \`3mi\`  \`100yrd\`

Plain \`m\` is ALWAYS minutes. \`400m\` is 400 minutes, not 400 metres; metres are
\`mtr\`. This one silently produces a 6.7-hour step.

Clock formats are NOT parsed: \`5:00\` and \`1:30:00\` as a step length drop the
line. Write \`5m\` and \`1h30m\`. (Colons are fine inside a *pace* target, which
is a different position on the line - see below.)

There is no manual / press-lap step. \`lap press\` is not a length; a line that
starts with it is read as prompt text and needs a real length after it.

## Targets

Power:   \`90%\` (of FTP)  \`88-94%\`  \`250w\`  \`240-260w\`  \`Z4\`
HR:      \`75% HR\`  \`70-80% HR\`  \`Z2 HR\`  \`80% LTHR\`
Pace:    \`90% pace\` (of threshold pace / swim CSS)  \`85-90% pace\`
         \`5:00/km pace\`  \`8:00/mi pace\`  \`1:45/100m pace\`  \`1:40/100y pace\`  \`Z3 pace\`
Cadence: \`90rpm\`  \`85-95rpm\`
Ramp:    \`- 10m ramp 50-75%\`  \`- 10m ramp 60-80% pace\`
None:    \`- 20m free\` (ERG off, no target)

A bare percentage or a bare \`Zn\` is always POWER, in every sport. \`- 10m 70%\`
in a run workout is 70% of FTP, not of threshold pace, and \`- 10m Z2\` is a
power zone. Running and swimming steps need the \`pace\` or \`HR\` word on every
line that should target one.

The trailing word \`pace\` is required on every pace target, absolute ones
included: bare \`5:00/km\` is dropped. Swim pace denominators are \`/100m\` and
\`/100y\` - note the asymmetry with step distances, which are \`mtr\` and \`yrd\`.

Absolute heart rate in bpm is NOT parsed, in any spelling: \`145bpm\`,
\`140-150bpm\`, \`145 bpm\`, \`145bpm HR\` and \`145-155 HR\` all leave the step with
no target at all. Use a percentage instead - \`75% HR\` of max, or \`80% LTHR\` of
threshold HR - or a zone, \`Z2 HR\`.

Named race paces and threshold vocabulary - \`CSS\`, \`5K pace\`, \`marathon pace\`,
\`threshold\` - are NOT parsed either. Express intensity as a percentage of the
athlete's sport settings instead: \`100% pace\` is threshold pace (swim CSS).

Targets combine on one line, and text before the length becomes a device
prompt:

    - 10m 88-94% 90rpm
    - Spin easy 5m 50%

## Examples

Bike VO2max:

    Warmup
    - 15m ramp 45-70%

    3x
    - 30s 110% 100rpm
    - 1m 50%

    Main Set 5x
    - 3m 115%
    - 3m 50%

    Cooldown
    - 10m 50%

Run threshold:

    Warmup
    - 15m 70% pace

    Main Set 3x
    - 2km 100% pace
    - 3m 60% pace

    Cooldown
    - 10m 65% pace

Swim:

    Warmup
    - 400mtr 80% pace

    Main Set 8x
    - 100mtr 105% pace
    - 20s free

    Cooldown
    - 200mtr 75% pace
`;
