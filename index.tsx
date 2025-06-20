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
  @state() status = 'Tap to start';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
    }

    .status-container {
      position: absolute;
      bottom: 100px; /* Above control bar */
      left: 20px;
      right: 20px;
      z-index: 10;
      text-align: center;
      padding: 5px 10px;
      font-size: 0.9em;
      color: #FFFFFF;
      text-shadow: 0 0 4px rgba(0, 0, 0, 0.7);
      pointer-events: none; /* Allow clicks to pass through if needed */
    }

    .controls {
      z-index: 10;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: space-evenly;
      padding: 0 20px;
      background: rgba(25, 25, 25, 0.7);
      backdrop-filter: blur(10px) saturate(180%);
      -webkit-backdrop-filter: blur(10px) saturate(180%);
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .controls button {
      outline: none;
      border: none;
      color: white;
      border-radius: 50%; /* Circular buttons */
      background: rgba(255, 255, 255, 0.15);
      width: 56px;
      height: 56px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s ease, transform 0.1s ease;
    }

    .controls button:hover {
      background: rgba(255, 255, 255, 0.25);
    }

    .controls button:active {
      transform: scale(0.95);
    }
    
    .controls button.record-toggle {
      width: 68px; /* Larger primary button */
      height: 68px;
    }

    .controls button.record-toggle.recording {
      background-color: #D32F2F; /* Red when recording */
    }
    
    .controls button.record-toggle.recording:hover {
      background-color: #E53935;
    }

    .controls button svg {
      display: block; /* Helps with sizing/alignment */
    }

    /* Hide disabled buttons instead of using disabled attribute for cleaner look */
    .controls button.hidden {
      display: none;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
    if (this.outputAudioContext.state === 'suspended') {
      this.outputAudioContext.resume().catch(e => console.warn("Error resuming output audio context on init:", e));
    }
    if (this.inputAudioContext.state === 'suspended') {
        this.inputAudioContext.resume().catch(e => console.warn("Error resuming input audio context on init:", e));
    }
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);
    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';
    console.log(`Initializing session with model: ${model}`);

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            console.log('Session opened.');
            this.updateStatus('Connected. Tap to speak.');
          },
          onmessage: async (message: LiveServerMessage) => {
            // console.log('Received server message:', JSON.stringify(message, null, 2));
            try {
              const audio =
                message.serverContent?.modelTurn?.parts[0]?.inlineData;

              if (audio && audio.data) {
                if (this.outputAudioContext.state === 'suspended') {
                  console.log('Output AudioContext is suspended, attempting to resume before playback...');
                  await this.outputAudioContext.resume();
                }

                this.nextStartTime = Math.max(
                  this.nextStartTime,
                  this.outputAudioContext.currentTime,
                );
                
                console.log('Received audio data, attempting to decode and play...');
                const decodedBytes = decode(audio.data); // Can throw if base64 is malformed
                const audioBuffer = await decodeAudioData(
                  decodedBytes,
                  this.outputAudioContext,
                  24000, // Output sample rate
                  1,     // Number of channels
                );

                if (audioBuffer && audioBuffer.length > 0) {
                  const source = this.outputAudioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(this.outputNode);
                  source.addEventListener('ended', () =>{
                    this.sources.delete(source);
                    // console.log('Audio source finished playing.');
                  });

                  source.start(this.nextStartTime);
                  console.log(`Audio source started at: ${this.nextStartTime}, duration: ${audioBuffer.duration}s`);
                  this.nextStartTime = this.nextStartTime + audioBuffer.duration;
                  this.sources.add(source);
                } else {
                  console.warn('Decoded audio buffer is null or empty. Not playing.');
                }
              } else {
                // console.log('No audio data in server message.');
              }

              const interrupted = message.serverContent?.interrupted;
              if(interrupted) {
                console.log('Audio output interrupted by server.');
                for(const source of this.sources.values()) {
                  source.stop(); // Stop all currently playing sources
                  this.sources.delete(source);
                }
                this.nextStartTime = 0; // Reset next start time
              }
            } catch (e: any) {
              console.error('Error processing server message for audio output:', e);
              this.updateError(`Audio processing error: ${e.message || 'Unknown error'}`);
            }
          },
          onerror: (e: ErrorEvent) => { // Consider more specific error type if available from SDK
            console.error('Session error event:', e);
            this.updateError(`Session Error: ${e.message || 'Unknown network or session error'}`);
          },
          onclose: (e: CloseEvent) => {
            console.log(`Session closed. Code: ${e.code}, Reason: ${e.reason}, WasClean: ${e.wasClean}`);
            this.updateStatus(`Closed: ${e.reason || 'Tap to reconnect'}`);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
        },
      });
    } catch (e: any) {
      console.error("Connection/Session Initialization Failed:", e);
      this.updateError(`Connection failed: ${e.message || 'Unknown error during session init'}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ''; 
  }

  private updateError(msg: string) {
    console.error("Application Error Updated:", msg);
    this.error = msg;
    this.status = ''; 
  }

  private async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    try {
      if (this.inputAudioContext.state === 'suspended') {
        console.log('Input AudioContext is suspended, attempting to resume...');
        await this.inputAudioContext.resume();
      }
      if (this.outputAudioContext.state === 'suspended') { // Also ensure output context is live
        console.log('Output AudioContext is suspended (on startRecord), attempting to resume...');
        await this.outputAudioContext.resume();
      }
    } catch (e) {
        console.error("Error resuming audio contexts on start:", e);
        this.updateError(`Audio context resume error: ${e.message}`);
        return;
    }


    this.updateStatus('Requesting mic...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Listening...');
      console.log('Microphone access granted, listening...');

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
        if (!this.isRecording) return; 

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        if (this.session && this.session.sendRealtimeInput) {
          this.session.sendRealtimeInput({media: createBlob(pcmData)});
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      // this.scriptProcessorNode.connect(this.inputAudioContext.destination); // Avoid echo

      this.isRecording = true;
    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateError(`Mic error: ${err.message || 'Unknown microphone error'}`);
      this.stopRecording(); 
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
        if(this.isRecording) this.isRecording = false; 
        return;
    }
    
    if (this.isRecording) {
       console.log('Stopping recording...');
       // this.updateStatus('Processing...'); // Keep "Tap to speak" or error message
    }
    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; 
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
      console.log('Microphone stream stopped.');
    }
    
    if (this.status === 'Listening...' || this.status === 'Requesting mic...' || this.status === 'Processing...') {
        this.updateStatus('Tap to speak');
    }
  }

  private resetSession() {
    console.log('Resetting session...');
    this.stopRecording(); 
    this.session?.close(); // Close existing session if any
    
    // Clear any pending audio sources
    for(const source of this.sources.values()) {
        source.stop();
        this.sources.delete(source);
    }
    this.nextStartTime = 0;
    
    this.updateStatus('Resetting session...');
    setTimeout(() => {
        this.initSession(); // Re-initialize the session
    }, 250); // Small delay for cleanup and to avoid race conditions
  }

  render() {
    const messageToDisplay = this.error || this.status;

    const recordIcon = html`
      <svg xmlns="http://www.w3.org/2000/svg" height="32px" viewBox="0 -960 960 960" width="32px" fill="#FFFFFF">
        <path d="M480-400q-50 0-85-35t-35-85v-200q0-50 35-85t85-35q50 0 85 35t35 85v200q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T520-520v-200q0-17-11.5-28.5T480-760q-17 0-28.5 11.5T440-720v200q0 17 11.5 28.5T480-480Zm0 280q-83 0-156-31.5T197-297q-22-22-22.5-54.5T197-406l24-24q11-11 28-11t28.5 11.5Q289-418 297.5-399t8.5-40q36-66 104-97.5T520-568q86 0 152 32.5T776-438q12 18 12.5 39.5T778-359q11 11 10.5 27.5T760-303l-25 25q-21 21-53 21.5T628-278q-44 44-100 65.5T480-200Z"/>
      </svg>
    `;

    const stopIcon = html`
      <svg viewBox="0 0 100 100" width="32px" height="32px" fill="#FFFFFF" xmlns="http://www.w3.org/2000/svg">
        <rect x="15" y="15" width="70" height="70" rx="10" />
      </svg>
    `;
    
    const resetIcon = html`
      <svg xmlns="http://www.w3.org/2000/svg" height="28px" viewBox="0 -960 960 960" width="28px" fill="#FFFFFF">
        <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
      </svg>
    `;

    return html`
      <div class="app-container">
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
        
        <div class="status-container">
          ${messageToDisplay}
        </div>

        <div class="controls">
          <button
            id="resetButton"
            @click=${this.resetSession}
            class="${this.isRecording ? 'hidden' : ''}"
            aria-label="Reset Session"
            title="Reset Session">
            ${resetIcon}
          </button>
          <button
            id="recordToggleButton"
            class="record-toggle ${this.isRecording ? 'recording' : ''}"
            @click=${this.toggleRecording}
            aria-label=${this.isRecording ? 'Stop Recording' : 'Start Recording'}
            title=${this.isRecording ? 'Stop Recording' : 'Start Recording'}>
            ${this.isRecording ? stopIcon : recordIcon}
          </button>
          <!-- Placeholder for potential third button, keeps toggle centered if reset is hidden -->
          <div style="width: 56px; height: 56px;" class="${!this.isRecording ? 'hidden' : ''}"></div>
        </div>
      </div>
    `;
  }
}
