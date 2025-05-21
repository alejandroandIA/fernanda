// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

let mediaRecorder;
let audioChunks = [];
let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle'; // idle, listening_continuous, processing_vad_chunk, fernanda_speaking_continuous

// --- VAD (Voice Activity Detection) Variables ---
let audioContext;
let analyser;
let microphoneSource;
let scriptProcessor; // O AudioWorkletNode per approcci più moderni, ma ScriptProcessorNode è più semplice per iniziare
const VAD_SILENCE_THRESHOLD = 0.01; // Da tarare: sensibilità al volume. Valori da 0 a 1 (circa)
const VAD_SILENCE_DURATION_MS = 1500; // Millisecondi di silenzio prima di considerare l'utente aver finito di parlare
const VAD_SPEECH_MIN_DURATION_MS = 300; // Minima durata del parlato per inviare
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null; // Per tenere traccia dello stream del microfono

// Array per i chunk audio del turno corrente dell'utente
let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = ''; // Per sapere con che MIME type registrare
let recordingFilenameForVAD = ''; // Nome file per VAD

// --- Fine VAD Variables ---

function updateUI(state, buttonText, buttonIcon, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIcon}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    // Il pulsante è disabilitato solo durante l'elaborazione effettiva o se Fernanda parla
    controlButton.disabled = (state === 'processing_vad_chunk' || state === 'fernanda_speaking_continuous');
    if (state === 'fernanda_speaking_continuous') {
        // Permetti di interrompere Fernanda
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = false;
    }
    console.log("UI Update:", state, buttonText, statusText);
}


async function initializeAudioProcessing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        return false;
    }

    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048; // Dimensione FFT standard
        analyser.minDecibels = -90; // Range dinamico
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.85; // Smussamento

        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);

        // Scegli il MIME type preferito per MediaRecorder una volta sola all'inizio
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            recordingMimeType = 'audio/webm;codecs=opus';
            recordingFilenameForVAD = 'user_vad_audio.webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            recordingMimeType = 'audio/mp4';
            recordingFilenameForVAD = 'user_vad_audio.mp4';
        } else if (MediaRecorder.isTypeSupported('audio/wav')) {
            recordingMimeType = 'audio/wav';
            recordingFilenameForVAD = 'user_vad_audio.wav';
        } else {
            recordingMimeType = ''; // Lascia che il browser scelga
            recordingFilenameForVAD = 'user_vad_audio.unknown'; // Sarà un problema se non specificato
            console.warn("Nessun formato MIME esplicito supportato per la registrazione VAD. Potrebbero esserci problemi.");
        }
        console.log("VAD Recording MIME type:", recordingMimeType, "Filename:", recordingFilenameForVAD);

        return true;
    } catch (err) {
        console.error('Errore getUserMedia o AudioContext:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError') msg = 'Permesso microfono negato.';
        if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream) {
        console.error("AudioContext non inizializzato per VAD.");
        return;
    }
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = []; // Pulisci i chunk per il nuovo turno

    // Avvia MediaRecorder per catturare l'audio quando inizia il VAD
    // Questo MediaRecorder catturerà *tutto* l'audio mentre VAD è attivo.
    // Quando VAD rileva la fine di un turno, prenderemo i chunk raccolti.
    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    mediaRecorderForVAD = new MediaRecorder(globalStream, options);
    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0) {
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder for VAD started.");
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder for VAD stopped.");
        // Non fare nulla qui, la logica di invio è gestita dal VAD loop
    };
    mediaRecorderForVAD.start(250); // Raccogli chunk ogni 250ms

    processAudio(); // Avvia il loop di analisi VAD
}

function stopVAD() {
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor.onaudioprocess = null;
        scriptProcessor = null;
    }
    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }
    if (analyser) {
        analyser = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(console.error);
        audioContext = null;
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
    }
    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
        mediaRecorderForVAD.stop();
    }
    mediaRecorderForVAD = null;
    currentTurnAudioChunks = [];
    speaking = false;
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("VAD e MediaRecorder per VAD fermati.");
}


function processAudio() {
    if (currentConversationState !== 'listening_continuous') return; // Se non stiamo ascoltando, esci

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray); // O getByteFrequencyData

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += (dataArray[i] / 128.0 - 1.0) ** 2; // Normalizza e quadra per ottenere energia
    }
    const rms = Math.sqrt(sum / dataArray.length); // Root Mean Square

    const currentTime = performance.now();

    if (rms > VAD_SILENCE_THRESHOLD) { // Sta parlando
        if (!speaking) {
            speaking = true;
            speechStartTime = currentTime;
            console.log("VAD: Inizio parlato rilevato");
            // Non c'è bisogno di fare nulla qui con MediaRecorderForVAD, è già partito
        }
        silenceStartTime = currentTime; // Resetta il timer del silenzio
    } else { // Silenzio
        if (speaking) { // Era in uno stato di "parlato" e ora c'è silenzio
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                console.log("VAD: Fine parlato rilevata (silenzio sufficiente)");
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;
                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    console.log("VAD: Invio audio per trascrizione. Durata parlato:", speechDuration.toFixed(0), "ms");
                    
                    // Ferma temporaneamente MediaRecorder per ottenere il blob completo dei chunk correnti
                    // e poi riavvialo se la conversazione non è terminata.
                    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
                        mediaRecorderForVAD.stop(); // Questo triggererà ondataavailable una ultima volta
                    }

                    // Copia i chunk e pulisci l'array per il prossimo turno
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = [];
                    
                    // Determina il MIME type effettivo dai chunk
                    const actualMimeType = chunksToSend.length > 0 && chunksToSend[0].type ? chunksToSend[0].type : recordingMimeType;
                    const audioBlob = new Blob(chunksToSend, { type: actualMimeType || 'application/octet-stream' });
                    
                    sendAudioForTranscription(audioBlob, recordingFilenameForVAD);

                    // Dopo aver inviato, se siamo ancora in listening_continuous,
                    // MediaRecorder si riavvierà automaticamente dal `finally` di sendAudioForTranscription
                    // o dal loop successivo se non è stato fermato.
                    // Non c'è bisogno di riavviare MediaRecorder qui se `sendAudioForTranscription` lo gestisce
                    // o se `startVAD` viene richiamato.
                    // Per ora, `sendAudioForTranscription` riattiverà l'ascolto.
                    return; // Esci dal loop di processAudio, verrà ripreso dopo la trascrizione/risposta
                } else {
                    console.log("VAD: Parlato troppo breve o nessun chunk, non invio.", speechDuration, currentTurnAudioChunks.length);
                    // Ripulisci i chunk se il parlato era troppo breve
                    currentTurnAudioChunks = []; 
                    // Se MediaRecorder era stato fermato per errore, riavvialo
                    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive" && currentConversationState === 'listening_continuous') {
                         mediaRecorderForVAD.start(250);
                    }
                }
            }
        } else {
            // Silenzio continuo, non fare nulla
            silenceStartTime = currentTime;
        }
    }

    if (currentConversationState === 'listening_continuous') {
        requestAnimationFrame(processAudio); // Continua il loop
    }
}


async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto, non invio.");
        // Ritorna ad ascoltare se la sessione non è stata terminata
        if (currentConversationState !== 'idle') {
             updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Ascolto...');
             if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") mediaRecorderForVAD.start(250);
             requestAnimationFrame(processAudio);
        }
        return;
    }

    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);

    try {
        const transcribeResponse = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        if (!transcribeResponse.ok) {
            const errData = await transcribeResponse.json().catch(() => ({ error: "Errore API Trascrizione" }));
            throw new Error(errData.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = await transcribeResponse.json();
        console.log("Whisper transcript (VAD):", transcript);

        if (!transcript || transcript.trim().length < 2) {
            updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Non ho capito. Ripeti pure.');
            // Riavvia MediaRecorder se necessario e il loop VAD
            if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive" && currentConversationState === 'listening_continuous') mediaRecorderForVAD.start(250);
            if (currentConversationState === 'listening_continuous') requestAnimationFrame(processAudio);
            return;
        }
        await processChat(transcript); // Chiama processChat che gestirà la risposta e poi riprenderà VAD
    } catch (error) {
        console.error('Errore trascrizione (VAD):', error.message);
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', `Errore: ${error.message}. Riprova parlando.`);
        // Riavvia MediaRecorder se necessario e il loop VAD
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive" && currentConversationState === 'listening_continuous') mediaRecorderForVAD.start(250);
        if (currentConversationState === 'listening_continuous') requestAnimationFrame(processAudio);
    }
}


async function handleControlButtonClick() {
    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD();
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        // Se l'utente preme "Termina Conversazione"
        stopVAD();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        // Interrompi Fernanda
        if (currentAudio) {
            currentAudio.pause();
            if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
            isFernandaSpeaking = false;
        }
        // Torna ad ascoltare
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Ok, dimmi pure.');
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") mediaRecorderForVAD.start(250);
        requestAnimationFrame(processAudio); // Riprendi il loop VAD
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

// --- Le funzioni processChat e playFernandaAudio necessitano di piccole modifiche ---
async function processChat(transcript) {
    // Non cambiare stato UI qui se già in processing_vad_chunk, o gestiscilo meglio
    if (currentConversationState !== 'processing_vad_chunk') {
        updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda pensa...');
    } else {
         statusMessage.textContent = 'Fernanda pensa...'; // Aggiorna solo il messaggio
    }

    try {
        // QUI DOVRESTI INVIARE LA CRONOLOGIA DELLA CONVERSAZIONE
        const chatResponse = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // body: JSON.stringify({ prompt: transcript, history: conversationHistory }) // Esempio
            body: JSON.stringify({ prompt: transcript })
        });

        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: "Errore API Chat sconosciuto" }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply (VAD):", assistantReply);
        // QUI DOVRESTI AGGIORNARE LA CRONOLOGIA DELLA CONVERSAZIONE

        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: assistantReply })
        });

        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS sconosciuto" }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        playFernandaAudio(audioUrl); // playFernandaAudio ora deve riprendere VAD onended

    } catch (error) {
        console.error('Errore nel flusso chat/tts (VAD):', error);
        // Se c'è un errore, torna ad ascoltare
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', `Oops: ${error.message}. Riprova.`);
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive" && currentConversationState === 'listening_continuous') mediaRecorderForVAD.start(250);
        if (currentConversationState === 'listening_continuous') requestAnimationFrame(processAudio);
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    // Lo stato del bottone è già "Termina Conversazione", ma aggiorniamo testo e icona per "Interrompi Fernanda"
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking (VAD).");
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        // Se la conversazione non è stata terminata dall'utente, torna ad ascoltare
        if (currentConversationState === 'fernanda_speaking_continuous') {
            updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Tocca a te...');
            // Riavvia MediaRecorder per il VAD se necessario e il loop
            if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") mediaRecorderForVAD.start(250);
            requestAnimationFrame(processAudio);
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback (VAD):", e);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') { // Solo se era in questo stato
            updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Problema audio. Riprova parlando.');
            if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") mediaRecorderForVAD.start(250);
            requestAnimationFrame(processAudio);
        }
    };

    const playPromise = currentAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error("Autoplay bloccato o errore play (VAD):", error);
            if (isFernandaSpeaking) { // Solo se era in questo stato e non interrotta
                isFernandaSpeaking = false;
                updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Audio bloccato. Riprova parlando.');
                if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") mediaRecorderForVAD.start(250);
                requestAnimationFrame(processAudio);
            }
            if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        });
    }
}

// Stato iniziale UI
updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
}
