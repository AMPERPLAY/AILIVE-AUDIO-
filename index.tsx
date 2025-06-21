
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

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new window.AudioContext({sampleRate: 16000});
  private outputAudioContext = new window.AudioContext({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode; // Corrected type
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

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
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

    console.log('[DEBUG] Attempting to use API_KEY from process.env:', process.env.API_KEY);

    if (!process.env.API_KEY) {
      this.updateError('API_KEY is not available. Please ensure it is configured correctly in your environment variables and accessible to the client-side code.');
      console.error('[GDM Live Audio] CRITICAL: process.env.API_KEY is undefined or empty. The application will not function correctly.');
      return; 
    }
    
    try {
      this.client = new GoogleGenAI({
        apiKey: process.env.API_KEY,
      });

      this.outputNode.connect(this.outputAudioContext.destination);
      this.initSession();

    } catch (e) {
      this.updateError(`Failed to initialize GoogleGenAI client: ${e.message}. This usually indicates an issue with the API Key.`);
      console.error('Error initializing GoogleGenAI client:', e);
    }
  }

  private async initSession() {
    if (!this.client) {
      this.updateError('Gemini client not initialized. Cannot create session.');
      console.error('[GDM Live Audio] Gemini client not available for session initialization.');
      return;
    }
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';
    console.log('[GDM Live Audio] Initializing session with model:', model);

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Connection Opened');
            console.log('[GDM Live Audio] Session: Connection Opened.');
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('[GDM Live Audio] Session: Message received:', JSON.stringify(message, null, 2));
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio && audio.data) {
              console.log('[GDM Live Audio] Session: Audio data found in message.');
              
              // Ensure output audio context is running
              if (this.outputAudioContext.state === 'suspended') {
                console.log('[GDM Live Audio] Output audio context is suspended, attempting to resume.');
                await this.outputAudioContext.resume();
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
                    24000, // Expected sample rate from Gemini for this model
                    1,     // Expected number of channels
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
            // ErrorEvent is a bit generic. Try to get more info.
            const errorDetails = e.message || (e.error ? e.error.message : e.type || 'Unknown session error');
            this.updateError(`Session error: ${errorDetails}`);
            console.error('[GDM Live Audio] Session onerror:', e, 'Details:', errorDetails);
          },
          onclose: (e: CloseEvent) => {
            const reason = e.reason || 'No reason provided';
            this.updateStatus(`Connection Closed: ${reason} (Code: ${e.code}, Clean: ${e.wasClean})`);
            console.warn(`[GDM Live Audio] Session onclose: Code=${e.code}, Reason=${reason}, WasClean=${e.wasClean}`, e);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB' // Example, if you want to specify language
          },
        },
      });
      console.log('[GDM Live Audio] Session object created:', this.session);
      this.updateStatus('Session initialized. Ready to start.');
    } catch (e) {
      this.updateError(`Failed to initialize session: ${e.message}`);
      console.error('[GDM Live Audio] Error initializing session:', e);
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

    if (!this.session) {
      this.updateError('Session not initialized. Cannot start recording. Check API Key and network, then try resetting.');
      return;
    }
    
    // Ensure both contexts are running
    if (this.inputAudioContext.state === 'suspended') {
      console.log('[GDM Live Audio] Input audio context is suspended, attempting to resume.');
      await this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
      console.log('[GDM Live Audio] Output audio context is suspended, attempting to resume.');
      await this.outputAudioContext.resume();
    }

    if (this.inputAudioContext.state !== 'running') {
        this.updateError('Input audio context could not be started. Microphone may be blocked or unavailable.');
        return;
    }
     if (this.outputAudioContext.state !== 'running') {
        this.updateError('Output audio context could not be started.');
        // Potentially less critical to block recording, but good to note
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

      const bufferSize = 256; // Consider adjusting if needed, though 256 is small and good for low latency
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1, // input channels
        1, // output channels
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return; 

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        
        try {
            if (this.session && this.isRecording) { // Double check
                 this.session.sendRealtimeInput({media: createBlob(pcmData)});
            }
        } catch (e) {
            console.error("[GDM Live Audio] Error sending realtime input:", e);
            this.updateError(`Error sending audio: ${e.message}. Try resetting.`);
            this.stopRecording(); 
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      // It's common to connect scriptProcessorNode to destination if you want to hear your own raw input,
      // but usually not needed if you only expect processed output from Gemini.
      // For this app, let's not connect it to destination to avoid echo unless intended.
      // this.scriptProcessorNode.connect(this.inputAudioContext.destination); 
      // Instead, ensure the graph is valid by connecting to a GainNode that might go nowhere if not needed for playback.
      // Or, if the Gemini SDK handles its own input processing without needing this node to connect to destination, this is fine.
      // The crucial part is that onaudioprocess fires.

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
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext && !this.scriptProcessorNode) {
      console.log('[GDM Live Audio] Stop recording called, but not in a state to stop anything significant.');
      return;
    }
      

    this.updateStatus('Stopping recording...');
    console.log('[GDM Live Audio] Stopping recording.');

    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; // Remove handler
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
    
    // Optional: Suspend audio context if no longer needed to save resources, but might need resume on next start
    // if (this.inputAudioContext.state === 'running') this.inputAudioContext.suspend();

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    this.updateStatus('Resetting session...');
    console.log('[GDM Live Audio] Resetting session.');
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
    // Re-initialize client and session after a brief delay
    // This also re-initializes audio contexts implicitly if they were part of initAudio
    setTimeout(() => {
      console.log('[GDM Live Audio] Re-initializing client and session after reset.');
      this.initClient(); // Re-init client which will then re-init session
    }, 250);
  }

  render() {
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
            @click=${this.startRecording}
            ?disabled=${this.isRecording}
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

