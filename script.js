const unlockButton = document.getElementById('unlockButton');
const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;
let audioContext;
let currentAudioPlayer = new Audio(); // Oggetto Audio riutilizzabile
let currentAudioUrl = null;

// Funzione per sbloccare l'audio (chiamata dal click su unlockButton)
unlockButton.onclick = async () => {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Trucco per sbloccare l'elemento Audio HTML5
        currentAudioPlayer.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"; // Silenzio
        await currentAudioPlayer.play();
        currentAudioPlayer.pause();
        currentAudioPlayer.currentTime = 0;
        currentAudioPlayer.src = ""; // Rimuovi la sorgente silenziosa

        statusDiv.textContent = 'Audio abilitato! Premi "Parla".';
        unlockButton.disabled = true;
        unlockButton.style.display = 'none'; // Nasconde il pulsante sblocca
        startButton.disabled = false;      // Abilita il pulsante "Parla"
        console.log("Audio sbloccato e pronto.");

    } catch (error) {
        console.error("Errore nello sblocco audio:", error);
        statusDiv.textContent = "Impossibile abilitare l'audio. Controlla i permessi e ricarica.";
        alert("L'audio non può essere abilitato. Assicurati di aver dato i permessi per la riproduzione automatica dell'audio per questo sito nelle impostazioni del tuo browser e ricarica la pagina.\nErrore: " + error.message);
    }
};

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    startButton.onclick = () => {
        if (currentAudioPlayer && !currentAudioPlayer.paused) {
            currentAudioPlayer.pause();
            currentAudioPlayer.currentTime = 0;
            if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
        }
        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true; startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = async (event) => {
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';
        startButton.disabled = true; startButton.textContent = "Elaboro...";

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userMessage: speechResult }),
            });

            if (!response.ok) {
                let errorDetails = 'Errore API chat sconosciuto';
                try {
                    const errorData = await response.json();
                    errorDetails = errorData.error || (errorData.details ? JSON.stringify(errorData.details) : response.statusText);
                } catch (e) { errorDetails = response.statusText; }
                throw new Error(`Errore dalla API Chat: ${errorDetails} (Status: ${response.status})`);
            }

            const data = await response.json();
            const aiResponse = data.reply;

            if (aiResponse) {
                addMessageToChat('AI: ' + aiResponse, 'assistant');
                speak(aiResponse);
            } else {
                addMessageToChat('AI: Non ho ricevuto una risposta valida da OpenAI.', 'assistant');
                statusDiv.textContent = 'Problema con la risposta. Premi "Parla" per riprovare.';
                startButton.disabled = false; startButton.textContent = "🎤 Parla";
            }
        } catch (error) {
            console.error('Errore nella chiamata API chat o nella gestione della risposta:', error);
            addMessageToChat('AI: Spiacente, c\'è stato un errore (chat): ' + error.message, 'assistant');
            statusDiv.textContent = 'Errore. Premi "Parla" per riprovare.';
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onspeechend = () => { recognition.stop(); };
    recognition.onnomatch = () => {
        statusDiv.textContent = "Non ho capito. Prova a parlare più chiaramente.";
        startButton.disabled = false; startButton.textContent = "🎤 Parla";
    };
    recognition.onerror = (event) => {
        let errorMessage = 'Errore nel riconoscimento: ' + event.error;
        if (event.error === 'no-speech') { errorMessage = 'Non ho sentito nulla. Assicurati che il microfono sia attivo.'; }
        else if (event.error === 'audio-capture') { errorMessage = 'Problema con il microfono. Controlla i permessi.'; }
        else if (event.error === 'not-allowed' || event.error === 'aborted') { errorMessage = 'Permesso microfono negato o ascolto interrotto.'; }
        statusDiv.textContent = errorMessage;
        console.error("SpeechRecognition Error:", event);
        startButton.disabled = false; startButton.textContent = "🎤 Parla";
    };

} else {
    startButton.disabled = true;
    unlockButton.disabled = true; // Disabilita anche il pulsante sblocca se SpeechRec non è supportato
    statusDiv.textContent = "Il tuo browser non supporta il riconoscimento vocale.";
    alert("Il tuo browser non supporta l'API Web Speech. Prova con Chrome o Edge aggiornati.");
}

function addMessageToChat(message, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);
    messageElement.textContent = message;
    outputDiv.appendChild(messageElement);
    outputDiv.scrollTop = outputDiv.scrollHeight;
}

async function speak(textToSpeak) {
    if (!textToSpeak) {
        startButton.disabled = false; startButton.textContent = "🎤 Parla"; return;
    }
    statusDiv.textContent = "L'AI sta parlando...";
    startButton.disabled = true; startButton.textContent = "Attendere...";

    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }

    try {
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textToSpeak }),
        });

        if (!response.ok) {
            let errorDetails = 'Errore generazione audio';
            try {
                const errorData = await response.json();
                errorDetails = errorData.error?.message || JSON.stringify(errorData.details) || 'Dettagli non disponibili';
            } catch (e) { errorDetails = response.statusText; }
            throw new Error(`${errorDetails} (Status: ${response.status})`);
        }

        const audioBlob = await response.blob();
        currentAudioUrl = URL.createObjectURL(audioBlob);
        
        currentAudioPlayer.src = currentAudioUrl;

        // Rimuovi vecchi listener per evitare duplicazioni e problemi
        currentAudioPlayer.onended = null;
        currentAudioPlayer.onerror = null;
        // oncanplaythrough non è strettamente necessario se play() viene chiamato subito dopo src
        // ma può essere utile per scenari più complessi o browser pignoli. Per ora lo omettiamo per semplicità.

        await currentAudioPlayer.play(); // Play è ora più probabile che funzioni grazie allo sblocco iniziale

        currentAudioPlayer.onended = () => {
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        };

        currentAudioPlayer.onerror = (e) => {
            console.error('Errore Audio Player:', e);
            statusDiv.textContent = 'Errore riproduzione audio.';
            if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
            addMessageToChat('AI (audio error): ' + (e.message || "Errore sconosciuto dell'elemento audio."), 'assistant');
        };

    } catch (error) {
        console.error('Errore API TTS o riproduzione:', error);
        statusDiv.textContent = 'Errore generazione/riproduzione audio.';
        startButton.disabled = false; startButton.textContent = "🎤 Parla";
        addMessageToChat('AI (TTS/play error): ' + error.message, 'assistant');
        if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
    }
}
