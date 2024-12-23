import type { AudioMetadata, ParseSubtitleOptions } from "./subtitle"

import { connect } from "./connect"
import { parseSubtitle } from "./subtitle"

/**
 * Options that will be sent alongside the websocket request
 */
interface GenerateOptions {
  /** The text that will be generated as audio */
  text: string

  /**
   * Voice persona used to read the message.
   * Please refer to [Language and voice support for the Speech service](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)
   *
   * Defaults to `"en-US-AvaNeural"`
   */
  voice?: string

  /**
   * Language of the message.
   * Please refer to [Language and voice support for the Speech service](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)
   *
   * Defaults to `"en-US"`
   */
  language?: string

  /**
   * Format of the audio output.
   * Please refer to [SpeechSynthesisOutputFormat Enum](https://learn.microsoft.com/en-us/dotnet/api/microsoft.cognitiveservices.speech.speechsynthesisoutputformat?view=azure-dotnet)
   *
   * Defaults to `"audio-24khz-96kbitrate-mono-mp3"`
   */
  outputFormat?: string

  /**
   * Indicates the speaking rate of the text.
   * Please refer to [Customize voice and sound with SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#adjust-prosody)
   *
   * Defaults to `"default"`
   */
  rate?: string

  /**
   * Indicates the baseline pitch for the text.
   * Please refer to [Customize voice and sound with SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#adjust-prosody)
   *
   * Defaults to `"default"`
   */
  pitch?: string

  /**
   * Indicates the volume level of the speaking voice.
   * Please refer to [Customize voice and sound with SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#adjust-prosody)
   * @default "default"
   */
  volume?: string

  subtitle?: Omit<ParseSubtitleOptions, "metadata">
}

interface GenerateResult {
  audio: Blob
  subtitle: ReturnType<typeof parseSubtitle>
}

// const defaultOptions: Partial<GenerateOptions> = {
//   voice: "en-US-AvaNeural",
//   language: "en-US",

//   outputFormat: "audio-24khz-96kbitrate-mono-mp3",
//   rate: "default",
//   pitch: "default",
//   volume: "default",

//   subtitle: {
//     splitBy: "sentence",
//   },
// }

/**
 * Asynchronously generates audio and subtitle data based on the provided options.
 *
 * @param options - The options for generating audio and subtitle data.
 * @return  A promise that resolves with the generated audio and subtitle data.
 */
export async function generate(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const voice = options.voice ?? "en-US-AvaNeural"
  const language = options.language ?? "en-US"

  const outputFormat = options.outputFormat ?? "audio-24khz-96kbitrate-mono-mp3"
  const rate = options.rate ?? "default"
  const pitch = options.pitch ?? "default"
  const volume = options.volume ?? "default"

  const subtitle: Omit<ParseSubtitleOptions, "metadata"> = {
    splitBy: "sentence",
    count: 1,
    ...options.subtitle,
  }

  const socket = await connect(outputFormat)

  const requestId = globalThis.crypto.randomUUID()

  const requestString = `
  X-RequestId:${requestId}\r\n
  Content-Type:application/ssml+xml\r\n
  Path:ssml\r\n\r\n

  <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}">
    <voice name="${voice}">
      <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">
        ${options.text}
      </prosody>
    </voice>
  </speak>
  `

  const audioChunks: Array<Uint8Array> = []
  const subtitleChunks: Array<AudioMetadata> = []
  const rawAudioChunks: Array<BlobPart> = []
  let isAudioComplete = false
  let expectedLength = 0

  const { promise, resolve, reject } = Promise.withResolvers<GenerateResult>()

  // Add timeout
  const timeout = setTimeout(() => {
    socket.close()
    reject(new Error("Connection timeout after 30 seconds"))
  }, 30000)

  async function dealRawAudioChunks() {
    while (rawAudioChunks.length) {
      const data = rawAudioChunks.shift()
      if (!data) continue
      const blob = new Blob([data])
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const binaryString = new TextDecoder().decode(bytes)
      const separator = "Path:audio\r\n"
      const index = binaryString.indexOf(separator)
      if (index !== -1) {
        const headerText = binaryString.substring(0, index)
        const contentLengthMatch = /Content-Length: (\d+)/i.exec(headerText)
        if (contentLengthMatch) {
          expectedLength += parseInt(contentLengthMatch[1], 10)
        }
        const audioData = bytes.subarray(index + separator.length)
        audioChunks.push(audioData)
      }
    }
  }

  socket.addEventListener("close", (event) => {
    if (!isAudioComplete) {
      reject(
        new Error(
          `WebSocket closed unexpectedly: ${event.code} ${event.reason}`,
        ),
      )
    }
    clearTimeout(timeout)
  })

  socket.send(requestString)

  socket.addEventListener("error", (error) => {
    clearTimeout(timeout)
    reject(error)
  })

  socket.addEventListener(
    "message",
    async (message: MessageEvent<string | Blob>) => {
      try {
        if (typeof message.data !== "string") {
          rawAudioChunks.push(message.data)
          return
        }

        if (message.data.includes("Path:audio.metadata")) {
          const jsonString = message.data.split("Path:audio.metadata")[1].trim()
          const json = JSON.parse(jsonString) as AudioMetadata

          return subtitleChunks.push(json)
        }

        if (message.data.includes("Path:turn.end")) {
          await dealRawAudioChunks()
          const totalLength = audioChunks.reduce(
            (acc, chunk) => acc + chunk.length,
            0,
          )

          if (expectedLength > 0 && totalLength < expectedLength) {
            reject(
              new Error(
                `Incomplete audio data: got ${totalLength} bytes, expected ${expectedLength} bytes`,
              ),
            )
            return
          }

          isAudioComplete = true
          clearTimeout(timeout)
          resolve({
            audio: new Blob(audioChunks, { type: "audio/mp3" }),
            subtitle: parseSubtitle({ metadata: subtitleChunks, ...subtitle }),
          })
          socket.close()
        }
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    },
  )

  return promise
}
