const FACTOR = 10_000

const convertToMs = (duration: number) => Math.floor(duration / FACTOR)

export interface AudioMetadata {
  Metadata: [WordBoundary]
}

export interface ParseSubtitleOptions {
  /**
   * The function will split the cues based on this option
   *
   * - `"sentence"` will split the text using `Intl.Segmenter`
   * - `"word"` will split the text to X count of words for each cue
   * - `"duration"` will split the text to X duration of milliseconds for each cue
   */
  splitBy: "sentence" | "word" | "duration"

  /**
   * Used only when `splitBy` is `"word"` to specify the number of words per cue.
   */
  wordsPerCue?: number

  /**
   * Used only when `splitBy` is `"duration"` to specify the duration of each cue in milliseconds.
   */
  durationPerCue?: number

  /**
   * Array of metadata received throughout the websocket connection
   */
  metadata: Array<AudioMetadata>

  count?: number
}

/**
 * Parsed cue in js
 */
interface ParseSubtitleResult {
  /**
   * Text of the cue
   */
  text: string

  /**
   * The start timestamp of the cue in milliseconds
   */
  start: number

  /**
   * The end timestamp of the cue in milliseconds
   */
  end: number

  /**
   * The duration of the cue in milliseconds
   */
  duration: number
}

interface WordBoundary {
  Type: "WordBoundary"
  Data: {
    Offset: number
    Duration: number
    text: {
      Text: string
      Length: number
      BoundaryType: "WordBoundary"
    }
  }
}

// const defaultOptions: Partial<ParseSubtitleOptions> = {
//   splitBy: "sentence",
//   wordsPerCue: 5,
//   durationPerCue: 5000,
// }

/**
 * Parses the metadata sent throughout the websocket connection and returns it as an array of object.
 *
 * @param options Options for parsing the subtitle
 * @returns The parsed subtitle array
 */
export function parseSubtitle({
  splitBy,
  count,
  metadata,
}: ParseSubtitleOptions): Array<ParseSubtitleResult> {
  const simplifiedMeta = metadata.map((meta) => ({
    text: meta.Metadata[0].Data.text.Text,
    offset: convertToMs(meta.Metadata[0].Data.Offset),
    duration: convertToMs(meta.Metadata[0].Data.Duration),
  }))

  if (splitBy === "sentence") {
    return simplifiedMeta.map((meta) => ({
      text: meta.text,
      start: meta.offset,
      duration: meta.duration,
      end: meta.offset + meta.duration,
    }))
  }

  if (splitBy === "duration") {
    if (count === undefined)
      throw new Error(
        "Count option must be provided when splitting by duration",
      )

    return simplifiedMeta.reduce<Array<ParseSubtitleResult>>(
      (prev, curr, index) => {
        if (
          (prev.at(-1)?.duration ?? 0) + curr.duration > count ||
          index === 0
        ) {
          prev.push({
            text: curr.text,
            start: curr.offset,
            duration: curr.duration,
            end: curr.offset + curr.duration,
          })
        } else {
          prev[prev.length - 1].end = curr.offset + curr.duration
          prev[prev.length - 1].text += ` ${curr.text}`
          prev[prev.length - 1].duration =
            prev[prev.length - 1].end - prev[prev.length - 1].start
        }

        return prev
      },
      [],
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (splitBy === "word") throw new Error("Not implemented")

  throw new Error("Invalid splitBy option")
}
