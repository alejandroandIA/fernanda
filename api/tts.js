export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required for speech synthesis' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY_FERNANDA;

    if (!OPENAI_API_KEY) {
        console.error('OpenAI API Key is not configured for TTS.');
        return res.status(500).json({ error: 'Server configuration error: API Key missing' });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'tts-1',       // Modello standard, veloce. Per qualità HD: 'tts-1-hd'
                input: text,
                voice: 'nova',        // Scegli una voce: alloy, echo, fable, onyx, nova, shimmer
                                      // 'nova' e 'alloy' sono spesso apprezzate per la naturalezza.
                response_format: 'mp3' // Formato audio
            }),
        });

        if (!response.ok) {
            const errorData = await response.json(); // OpenAI di solito risponde con JSON per errori TTS
            console.error('OpenAI TTS API Error:', errorData);
            return res.status(response.status).json({ error: 'Error from OpenAI TTS API', details: errorData });
        }

        // Invia l'audio direttamente come risposta. Il browser lo interpreterà come blob.
        res.setHeader('Content-Type', 'audio/mpeg');
        const audioBuffer = await response.arrayBuffer(); // Ottieni i dati audio come ArrayBuffer
        res.status(200).send(Buffer.from(audioBuffer)); // Invia il buffer

    } catch (error) {
        console.error('Server-side TTS error:', error);
        res.status(500).json({ error: 'Internal Server Error during TTS', details: error.message });
    }
}
