// api/chat.js
import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

const MAX_HISTORY_TOKENS = 3000; 
function countTokens(text) {
    return Math.ceil((text || '').length / 3); 
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { prompt, history } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!process.env.OPENAI_API_KEY_FERNANDA) {
        console.error('OPENAI_API_KEY_FERNANDA not configured');
        return res.status(500).json({ error: 'Server configuration error: OpenAI API key missing.' });
    }

    try {
        const systemMessage = {
            role: "system",
            content: "Sei Fernanda, un'assistente vocale AI amichevole, utile e concisa. Rispondi in italiano, in modo naturale come se stessi parlando. Mantieni il contesto della conversazione precedente per dare risposte coerenti."
        };

        // MODIFICA: Logica semplificata per la cronologia
        let processedHistory = [];
        if (Array.isArray(history)) {
            let currentTokenCount = 0;
            const reversedHistory = [...history].reverse(); // Inizia dai più recenti

            for (const message of reversedHistory) {
                // Non includere messaggi di sistema dalla cronologia (se ce ne fossero)
                if (message.role === 'system') continue;

                const messageTokenCount = countTokens(message.content);
                // Calcola lo spazio rimanente, considerando il system prompt, il prompt utente e un buffer per la risposta
                const remainingTokenSpaceForHistory = MAX_HISTORY_TOKENS - 
                                                   countTokens(systemMessage.content) - 
                                                   countTokens(prompt) - 
                                                   250; // Buffer per la risposta e piccole variazioni

                if (currentTokenCount + messageTokenCount < remainingTokenSpaceForHistory) {
                    processedHistory.unshift(message); // Aggiungi all'inizio per mantenere l'ordine
                    currentTokenCount += messageTokenCount;
                } else {
                    console.log("History truncation: max tokens reached for history part.");
                    break; 
                }
            }
        } else {
            console.warn("No history provided or history is not an array.");
        }

        const messages = [
            systemMessage,
            ...processedHistory,
            { role: "user", content: prompt }
        ];
        // Fine modifica logica cronologia

        console.log("Sending messages to OpenAI:", JSON.stringify(messages, null, 2));

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
            temperature: 0.7,
            max_tokens: 150,
        });

        const reply = completion.choices[0].message.content;
        res.status(200).json({ reply });

    } catch (error) {
        console.error('OpenAI API Error (chat):', error.status, error.message, error.response ? JSON.stringify(error.response.data, null, 2) : 'No response data');

        let userErrorMessage = 'Errore nel contattare il servizio AI (chat).';
        let statusCode = error.status || 500;
        if (error.response && error.response.status) {
            statusCode = error.response.status;
        }
        
        // Gestione errori OpenAI più specifica
        if (error.response && error.response.data && error.response.data.error) {
            userErrorMessage = error.response.data.error.message || userErrorMessage;
        } else if (error.message) { // Altri errori
            userErrorMessage = error.message;
        }


        if (statusCode === 401) {
            userErrorMessage = 'Errore di autenticazione con il servizio AI. Controlla la chiave API.';
        } else if (statusCode === 403) {
             userErrorMessage = `Il progetto non ha accesso al modello AI specificato (${error.response?.data?.error?.message || 'dettagli non disponibili'}). (Errore: ${statusCode})`;
        } else if (statusCode === 429) {
            userErrorMessage = 'Hai superato i limiti di richieste al servizio AI. Riprova più tardi.';
        } else if (error.code === 'insufficient_quota') { // Codice errore specifico OpenAI
            userErrorMessage = 'Quota OpenAI insufficiente. Controlla il tuo piano e i limiti di utilizzo.';
            statusCode = 429; // Ritorna 429 per coerenza con "rate limit"
        }

        res.status(statusCode).json({ error: userErrorMessage });
    }
}
