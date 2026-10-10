/**
 * A scriptable stand-in for the browser's SpeechRecognition, for tests (jsdom
 * has no Web Speech API). Inject `Recognition` through a component's
 * `getRecognitionConstructor` prop, then drive the session by hand:
 *
 * ```tsx
 * const speech = createFakeSpeechRecognition();
 * render(<VoiceTaskbar getRecognitionConstructor={() => speech.Recognition} />);
 * await user.click(screen.getByTestId('taskbar-mic'));
 * act(() => speech.latest().emitFinal('What is a heap?'));
 * ```
 *
 * start(), stop() and abort() only record the call; nothing happens until a
 * test emits the events a real recognizer would. Wrap emits in `act()`.
 */

import type {
  SpeechRecognitionConstructorLike,
  SpeechRecognitionLike,
  SpeechRecognitionResultEventLike,
} from '../useSpeechRecognition';

/** One recognized segment, as a test "says" it. */
export interface FakeSpeechResult {
  transcript: string;
  isFinal: boolean;
}

export class FakeSpeechRecognition implements SpeechRecognitionLike {
  // The Web Speech API's defaults.
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  onresult: SpeechRecognitionLike['onresult'] = null;
  onnomatch: SpeechRecognitionLike['onnomatch'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;

  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  /** Between start() and the end event. */
  private started = false;

  start(): void {
    // A real recognizer refuses to start twice.
    if (this.started) {
      throw new DOMException('Recognition has already started.', 'InvalidStateError');
    }
    this.started = true;
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  abort(): void {
    this.abortCalls += 1;
  }

  /** Fire a `result` event with these segments, the first changed one at `resultIndex`. */
  emitResults(results: FakeSpeechResult[], resultIndex = 0): void {
    const event: SpeechRecognitionResultEventLike = {
      resultIndex,
      results: results.map(({ transcript, isFinal }) => Object.assign([{ transcript }], { isFinal })),
    };
    this.onresult?.(event);
  }

  /** The recognizer's in-progress guess. */
  emitInterim(transcript: string): void {
    this.emitResults([{ transcript, isFinal: false }]);
  }

  /** The recognizer's final transcription of the utterance. */
  emitFinal(transcript: string): void {
    this.emitResults([{ transcript, isFinal: true }]);
  }

  /** Speech was heard but not recognized. */
  emitNoMatch(): void {
    this.onnomatch?.({ resultIndex: 0, results: [] });
  }

  /** A Web Speech API error, e.g. "no-speech" or "not-allowed". */
  emitError(error: string): void {
    this.onerror?.({ error, message: '' });
  }

  /** The session is over; a real recognizer always ends with this. */
  emitEnd(): void {
    this.started = false;
    this.onend?.(new Event('end'));
  }
}

export interface FakeSpeechRecognitionOptions {
  /** `new Recognition()` throws, as a present but unusable API may. */
  throwOnConstruct?: boolean;
  /** `start()` throws, as a browser refusing to start listening does. */
  throwOnStart?: boolean;
}

export interface FakeSpeechRecognitionApi {
  /** The constructor to inject. */
  Recognition: SpeechRecognitionConstructorLike;
  /** Every recognizer constructed so far, oldest first. */
  instances: FakeSpeechRecognition[];
  /** The most recently constructed recognizer. Throws if there is none. */
  latest: () => FakeSpeechRecognition;
}

/** A fresh fake SpeechRecognition constructor that tracks its instances. */
export function createFakeSpeechRecognition(
  options: FakeSpeechRecognitionOptions = {}
): FakeSpeechRecognitionApi {
  const instances: FakeSpeechRecognition[] = [];

  class Recognition extends FakeSpeechRecognition {
    constructor() {
      super();
      if (options.throwOnConstruct) {
        throw new Error('SpeechRecognition is not available.');
      }
      instances.push(this);
    }

    start(): void {
      if (options.throwOnStart) {
        throw new DOMException('Speech recognition was refused.', 'NotAllowedError');
      }
      super.start();
    }
  }

  return {
    Recognition,
    instances,
    latest: () => {
      const recognition = instances[instances.length - 1];
      if (!recognition) {
        throw new Error('No SpeechRecognition has been constructed yet.');
      }
      return recognition;
    },
  };
}
