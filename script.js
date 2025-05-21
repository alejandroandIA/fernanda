const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;
let currentAudio = null; // Per tenere traccia dell'audio in riproduzione e del suo URL

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    startButton.onclick = () => {
        if (currentAudio && currentAudio.audio && !currentAudio.audio.paused) {
            currentAudio.audio.pause();
            currentAudio.audio.currentTime = 0;
            if (currentAudio.url) {
                URL.revokeObjectURL(currentAudio.url);
            }
            currentAudio = null;
        }
        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true;
            startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = async (event) => {
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';
        startButton.disabled = true;
        startButton.textContent = "Elaboro...";

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

    if (currentAudio && currentAudio.url) { // Revoca l'URL precedente se esiste
        URL.revokeObjectURL(currentAudio.url);
    }
    currentAudio = null; // Resetta

    try {
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textToSpeak }),
        });

        if (!response.ok) {
            let errorDetails = 'Errore generazione audio';
            try { const errorData = await response.json(); errorDetails = errorData.error?.message || JSON.stringify(errorData.details) || 'Dettagli non disponibili'; }
            catch (e) { errorDetails = response.statusText; }
            throw new Error(`${errorDetails} (Status: ${response.status})`);
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        
        const audio = new Audio(audioUrl);
        currentAudio = { audio: audio, url: audioUrl }; // Salva audio e url

        audio.play().catch(e => {
            console.error("Errore durante la riproduzione dell'audio:", e);
            statusDiv.textContent = 'Errore riproduzione audio.';
            addMessageToChat('AI (audio play error): ' + e.message, 'assistant');
            if (currentAudio && currentAudio.url) { URL.revokeObjectURL(currentAudio.url); }
            currentAudio = null;
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        });

        audio.onended = () => {
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            if (currentAudio && currentAudio.url) { URL.revokeObjectURL(currentAudio.url); }
            currentAudio = null;
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        };

        audio.onerror = (e) => {
            console.error('Errore elemento Audio:', e);
            statusDiv.textContent = 'Errore caricamento/riproduzione audio.';
            if (currentAudio && currentAudio.url) { URL.revokeObjectURL(currentAudio.url); }
            currentAudio = null;
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
            addMessageToChat('AI (audio load/play error): Errore audio.', 'assistant');
        };

    } catch (error) {
        console.error('Errore nella sintesi vocale (chiamata a /api/tts):', error);
        statusDiv.textContent = 'Errore generazione audio.';
        startButton.disabled = false; startButton.textContent = "🎤 Parla";
        addMessageToChat('AI (TTS API error): ' + error.message, 'assistant');
        if (currentAudio && currentAudio.url) { URL.revokeObjectURL(currentAudio.url); }
        currentAudio = null;
    }
}
