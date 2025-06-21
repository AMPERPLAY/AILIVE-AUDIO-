
/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() isSessionInitialized = false; // To control button state

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new window.AudioContext({sampleRate: 16000});
  private outputAudioContext = new window.AudioContext({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode; 
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white; /* Ensure text is visible */
      padding: 5px;
      background-color: rgba(0,0,0,0.5); /* Slight background for readability */
      border-radius: 5px;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex; /* For centering icon */
        align-items: center; /* For centering icon */
        justify-content: center; /* For centering icon */

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        /* display: none; Replaced with opacity for better UX */
      }

      /* Hide start if recording, hide stop if not recording */
      button#startButton[disabled], button#stopButton[disabled] {
         /* This handles the conditional display more directly than just :disabled */
      }
      button#startButton.hidden, button#stopButton.hidden {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    this.updateStatus('Initializing client...');
    this.isSessionInitialized = false;

    const apiKey = typeof process !== 'undefined' && process.env ? process.env.API_KEY : undefined;
    console.log('[DEBUG] Attempting to use API_KEY from process.env:', apiKey);


    if (!apiKey) {
      this.updateError('API_KEY is not available. Please ensure it is configured correctly in your environment variables and accessible to the client-side code.');
      console.error('[GDM Live Audio] CRITICAL: process.env.API_KEY is undefined or empty. The application will not function correctly.');
      this.isSessionInitialized = false; // Explicitly set
      return; 
    }
    
    try {
      this.client = new GoogleGenAI({
        apiKey: apiKey,
      });

      this.outputNode.connect(this.outputAudioContext.destination);
      this.initSession();

    } catch (e) {
      this.updateError(`Failed to initialize GoogleGenAI client: ${e.message}. This usually indicates an issue with the API Key.`);
      console.error('Error initializing GoogleGenAI client:', e);
      this.isSessionInitialized = false;
    }
  }

  private async initSession() {
    if (!this.client) {
      this.updateError('Gemini client not initialized. Cannot create session.');
      console.error('[GDM Live Audio] Gemini client not available for session initialization.');
      this.isSessionInitialized = false;
      return;
    }
    // Changed model to the recommended one
    const model = 'gemini-2.5-flash-preview-04-17'; 
    console.log('[GDM Live Audio] Initializing session with model:', model);
    this.updateStatus('Initializing session with Gemini...');

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Connection Opened. Session is active.');
            console.log('[GDM Live Audio] Session: Connection Opened.');
            this.isSessionInitialized = true;
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('[GDM Live Audio] Session: Message received:', JSON.stringify(message, null, 2));
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio && audio.data) {
              console.log('[GDM Live Audio] Session: Audio data found in message.');
              
              if (this.outputAudioContext.state === 'suspended') {
                console.log('[GDM Live Audio] Output audio context is suspended, attempting to resume.');
                await this.outputAudioContext.resume().catch(err => {
                   console.error('[GDM Live Audio] Error resuming output audio context:', err);
                   this.updateError('Could not resume audio output.');
                });
              }
              
              if (this.outputAudioContext.state === 'running') {
                console.log('[GDM Live Audio] Output audio context is running.');
                this.nextStartTime = Math.max(
                  this.nextStartTime,
                  this.outputAudioContext.currentTime,
                );
                console.log(`[GDM Live Audio] Next start time for audio: ${this.nextStartTime}`);

                try {
                  const audioBuffer = await decodeAudioData(
                    decode(audio.data),
                    this.outputAudioContext,
                    24000, 
                    1,     
                  );
                  console.log(`[GDM Live Audio] Audio decoded. Buffer duration: ${audioBuffer.duration}`);
                  
                  const source = this.outputAudioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(this.outputNode);
                  source.addEventListener('ended', () =>{
                    console.log('[GDM Live Audio] Audio source ended.');
                    this.sources.delete(source);
                  });

                  source.start(this.nextStartTime);
                  console.log(`[GDM Live Audio] Audio source started at: ${this.nextStartTime}`);
                  this.nextStartTime = this.nextStartTime + audioBuffer.duration;
                  this.sources.add(source);
                } catch (decodeError) {
                  console.error('[GDM Live Audio] Error decoding audio data:', decodeError);
                  this.updateError(`Error processing received audio: ${decodeError.message}`);
                }
              } else {
                console.warn('[GDM Live Audio] Output audio context is not running. Cannot play audio.');
                this.updateError('Audio output context is not active.');
              }
            } else {
              console.log('[GDM Live Audio] Session: No audio data in current message part.');
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              console.log('[GDM Live Audio] Session: Interrupted signal received. Stopping current audio playback.');
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => { 
            const errorDetails = e.message || (e.error ? e.error.message : e.type || 'Unknown session error');
            this.updateError(`Session error: ${errorDetails}`);
            console.error('[GDM Live Audio] Session onerror:', e, 'Details:', errorDetails);
            this.isSessionInitialized = false;
          },
          onclose: (e: CloseEvent) => {
            const reason = e.reason || 'No reason provided';
            this.updateStatus(`Connection Closed: ${reason} (Code: ${e.code}, Clean: ${e.wasClean})`);
            console.warn(`[GDM Live Audio] Session onclose: Code=${e.code}, Reason=${reason}, WasClean=${e.wasClean}`, e);
            this.isSessionInitialized = false;
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
        },
      });
      console.log('[GDM Live Audio] Session object created (pending connection):', this.session);
      // Status update moved to onopen
    } catch (e) {
      this.updateError(`Failed to initialize session: ${e.message}`);
      console.error('[GDM Live Audio] Error initializing session:', e);
      this.isSessionInitialized = false;
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ''; 
    console.log(`[GDM Live Audio] Status: ${msg}`);
  }

  private updateError(msg: string) {
    this.error = `Error: ${msg}`;
    this.status = ''; 
    console.error(`[GDM Live Audio] ${this.error}`);
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    if (!this.session || !this.isSessionInitialized) {
      this.updateError('Session not initialized or not active. Cannot start recording. Check API Key and network, then try resetting.');
      return;
    }
    
    if (this.inputAudioContext.state === 'suspended') {
      console.log('[GDM Live Audio] Input audio context is suspended, attempting to resume.');
      await this.inputAudioContext.resume().catch(err => {
          console.error('[GDM Live Audio] Error resuming input audio context:', err);
          this.updateError('Could not resume audio input.');
      });
    }
    if (this.outputAudioContext.state === 'suspended') {
      console.log('[GDM Live Audio] Output audio context is suspended, attempting to resume.');
      await this.outputAudioContext.resume().catch(err => {
           console.error('[GDM Live Audio] Error resuming output audio context:', err);
      });
    }

    if (this.inputAudioContext.state !== 'running') {
        this.updateError('Input audio context could not be started. Microphone may be blocked or unavailable.');
        return;
    }

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');
      console.log('[GDM Live Audio] Microphone access granted.');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256; 
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1, 
        1, 
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session || !this.isSessionInitialized) return; 

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        
        try {
            if (this.session && this.isRecording) { 
                 this.session.sendRealtimeInput({media: createBlob(pcmData)});
            }
        } catch (e) {
            console.error("[GDM Live Audio] Error sending realtime input:", e);
            this.updateError(`Error sending audio: ${e.message}. Try resetting.`);
            this.stopRecording(); 
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination); 
      
      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
      console.log('[GDM Live Audio] Recording started. Script processor active.');
    } catch (err) {
      console.error('[GDM Live Audio] Error starting recording:', err);
      this.updateError(`Failed to start recording: ${err.message}. Check microphone permissions.`);
      this.stopRecording(); 
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.scriptProcessorNode) {
      // Avoid verbose logging if already mostly stopped
      if (this.isRecording || this.mediaStream || this.scriptProcessorNode) {
         console.log('[GDM Live Audio] Stop recording called, but not in a fully active recording state.');
      }
      this.isRecording = false; // Ensure state is correct
      return;
    }
      
    this.updateStatus('Stopping recording...');
    console.log('[GDM Live Audio] Stopping recording.');

    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; 
      this.scriptProcessorNode = null;
      console.log('[GDM Live Audio] Script processor disconnected.');
    }
    
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
      console.log('[GDM Live Audio] Source node disconnected.');
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
      console.log('[GDM Live Audio] Media stream tracks stopped.');
    }
    
    this.updateStatus('Recording stopped. Ready to start again if session is active.');
  }

  private reset() {
    this.updateStatus('Resetting session...');
    console.log('[GDM Live Audio] Resetting session.');
    this.isSessionInitialized = false; // Mark as not initialized during reset
    this.stopRecording(); 
    if (this.session) {
       try {
        this.session.close();
        console.log('[GDM Live Audio] Existing session closed.');
       } catch (e) {
        console.warn("[GDM Live Audio] Error closing existing session during reset:", e);
       }
       this.session = null; 
    }
    setTimeout(() => {
      console.log('[GDM Live Audio] Re-initializing client and session after reset.');
      this.initClient(); 
    }, 250);
  }

  render() {
    const startButtonClasses = this.isRecording ? 'hidden' : '';
    const stopButtonClasses = !this.isRecording ? 'hidden' : '';

    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording} 
            aria-label="Reset Session">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            class=${startButtonClasses}
            @click=${this.startRecording}
            ?disabled=${this.isRecording || !this.isSessionInitialized}
            aria-label="Start Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            class=${stopButtonClasses}
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}
            aria-label="Stop Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status" role="status" aria-live="polite"> ${this.error || this.status} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
