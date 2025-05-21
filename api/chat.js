export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { userMessage } = req.body;

    if (!userMessage) {
        return res.status(400).json({ error: 'userMessage is required' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY_FERNANDA; // Useremo questo nome per la variabile d'ambiente

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-realtime-preview-2024-10-01', // Puoi cambiarlo con un altro modello se preferisci
                messages: [
                    { role: 'system', content: 'Sei un assistente utile e conciso.' },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.7, // Controlla la creatività. Più basso = più deterministico
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('OpenAI API Error:', errorData);
            return res.status(response.status).json({ error: 'Error from OpenAI API', details: errorData });
        }

        const data = await response.json();
        const assistantResponse = data.choices[0]?.message?.content.trim();

        if (assistantResponse) {
            res.status(200).json({ reply: assistantResponse });
        } else {
            res.status(500).json({ error: 'No response content from OpenAI' });
        }

    } catch (error) {
        console.error('Server-side error:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
