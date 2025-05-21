export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { userMessage } = req.body;

    if (!userMessage) {
        return res.status(400).json({ error: 'userMessage is required' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY_FERNANDA;

    if (!OPENAI_API_KEY) {
        console.error('OpenAI API Key is not configured.');
        return res.status(500).json({ error: 'Server configuration error: API Key missing' });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-realtime-preview-2024-10-01', // Il tuo modello
                messages: [
                    { role: 'system', content: 'Sei un assistente AI utile e conciso, che risponde in italiano.' },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.7,
            })
        });

        const responseBodyText = await response.text(); // Leggi come testo prima

        if (!response.ok) {
            console.error('OpenAI API Error Status:', response.status);
            console.error('OpenAI API Error Body:', responseBodyText);
            // Prova a parsare come JSON, ma se fallisce usa il testo
            let errorDetails = responseBodyText;
            try {
                const errorData = JSON.parse(responseBodyText);
                errorDetails = errorData.error?.message || JSON.stringify(errorData);
            } catch (e) {
                // Mantieni responseBodyText se non è JSON valido
            }
            return res.status(response.status).json({ error: 'Error from OpenAI API', details: errorDetails });
        }

        const data = JSON.parse(responseBodyText); // Ora parsa come JSON
        const assistantResponse = data.choices?.[0]?.message?.content?.trim();

        if (assistantResponse) {
            res.status(200).json({ reply: assistantResponse });
        } else {
            console.error('No response content from OpenAI. Full API response:', data);
            res.status(500).json({ error: 'No response content from OpenAI' });
        }

    } catch (error) {
        console.error('Server-side error (outside OpenAI call):', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
