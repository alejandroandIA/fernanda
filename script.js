const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT'; // Lingua italiana
    recognition.interimResults = false; // Solo risultati finali
    recognition.maxAlternatives = 1; // Solo la trascrizione più probabile

    startButton.onclick = () => {
        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true; // Disabilita il pulsante mentre ascolta
            startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = (event) => {
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI (simulato)...';

        // Simula la chiamata e la risposta di OpenAI per ora
        setTimeout(() => {
            const fakeOpenAiResponse = "Ho ricevuto: " + speechResult + ". Questa è una risposta simulata.";
            addMessageToChat('AI: ' + fakeOpenAiResponse, 'assistant');
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            // Qui, in futuro, riprodurremo l'audio della risposta
        }, 1500); // Simula un piccolo ritardo di rete
    };

    recognition.onspeechend = () => {
        recognition.stop();
        statusDiv.textContent = 'Ascolto terminato. Elaborazione...';
        startButton.disabled = false; // Riabilita il pulsante
        startButton.textContent = "🎤 Parla";
    };

    recognition.onnomatch = () => {
        statusDiv.textContent = "Non ho capito. Prova a parlare più chiaramente.";
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

    recognition.onerror = (event) => {
        statusDiv.textContent = 'Errore nel riconoscimento: ' + event.error;
        if (event.error === 'no-speech') {
            statusDiv.textContent = 'Non ho sentito nulla. Assicurati che il microfono sia attivo.';
        } else if (event.error === 'audio-capture') {
            statusDiv.textContent = 'Problema con il microfono. Controlla i permessi.';
        } else if (event.error === 'not-allowed') {
            statusDiv.textContent = 'Permesso di usare il microfono negato. Abilitalo nelle impostazioni del browser.';
        }
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
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
    outputDiv.scrollTop = outputDiv.scrollHeight; // Scrolla in fondo per vedere l'ultimo messaggio
}
