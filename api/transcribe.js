// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable';
import fs from 'fs';
import { toFile } from 'openai/uploads'; // o da 'openai/fs' a seconda della versione della libreria OpenAI

export const config = {
    api: {
        bodyParser: false,
    },
};

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!process.env.OPENAI_API_KEY_FERNANDA) {
        console.error('OPENAI_API_KEY_FERNANDA not configured');
        return res.status(500).json({ error: 'Server config error: OpenAI API key missing.' });
    }

    const form = formidable({ multiples: false });
    let tempFilePathForCleanup = null;
    let clientOriginalFilename = 'unknown_by_client'; // Valore di default

    try {
        const [fields, files] = await form.parse(req);
        const audioFileArray = files.audio;

        if (!audioFileArray || audioFileArray.length === 0) {
            return res.status(400).json({ error: 'No audio file uploaded.' });
        }

        const uploadedFile = audioFileArray[0];
        tempFilePathForCleanup = uploadedFile.filepath;
        clientOriginalFilename = uploadedFile.originalFilename || clientOriginalFilename; // Aggiorna con il nome file dal client

        // LOG DI DEBUG AGGIUNTIVI
        console.log('--- Transcribe API - DEBUG INFO (Server Side) ---');
        console.log('Received Upload Details from Formidable:');
        console.log('  Original Filename (as sent by client in FormData):', clientOriginalFilename);
        console.log('  Mimetype (detected by formidable on server):', uploadedFile.mimetype);
        console.log('  Temporary file path on server:', tempFilePathForCleanup);
        console.log('  File size on server (bytes):', uploadedFile.size);
        console.log('-----------------------------------------------');

        if (uploadedFile.size === 0) {
            console.error("[Transcribe API] Uploaded file is empty (size 0).");
            return res.status(400).json({ error: 'Audio file is empty.' });
        }

        // Verifica estensione del filename originale inviato dal client
        const hasValidExtension = /\.(flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i.test(clientOriginalFilename);

        if (!hasValidExtension) {
            console.warn(`[Transcribe API] Client's original filename '${clientOriginalFilename}' LACKS a standard supported audio extension. This is a likely cause for OpenAI type inference failure.`);
        } else {
            console.log(`[Transcribe API] Client's original filename '${clientOriginalFilename}' HAS a valid-looking extension.`);
        }

        console.log(`[Transcribe API] Preparing file for OpenAI. Using temp path: '${tempFilePathForCleanup}', and will pass explicit filename '${clientOriginalFilename}' to OpenAI for type inference.`);

        const fileForOpenAI = await toFile(
            fs.createReadStream(tempFilePathForCleanup),
            clientOriginalFilename // Questo filename è cruciale per l'inferenza del tipo da parte di OpenAI
        );

        console.log('[Transcribe API] File prepared for OpenAI. Attempting transcription...');
        const transcription = await openai.audio.transcriptions.create({ // Questa era la riga 66 nel tuo log originale
            file: fileForOpenAI,
            model: "whisper-1",
            language: "it",
            response_format: "json",
        });

        console.log('[Transcribe API] Whisper Transcription successful:', transcription.text);
        res.status(200).json({ transcript: transcription.text });

    } catch (error) {
        console.error('[Transcribe API] Full error object during transcription attempt:', error); // Log completo dell'errore
        let userErrorMessage = 'Errore durante la trascrizione.';
        let statusCode = 500;

        if (error.status && typeof error.status === 'number') {
            statusCode = error.status;
        }
        
        if (error.response && error.response.data && error.response.data.error) {
            const OAIError = error.response.data.error;
            console.error('[Transcribe API] OpenAI API Error Details:', JSON.stringify(OAIError, null, 2));
            
            userErrorMessage = OAIError.message || 'Errore sconosciuto da API OpenAI.';
            if (OAIError.code) {
                userErrorMessage = `[OpenAI Code: ${OAIError.code}] ${userErrorMessage}`;
            }
            statusCode = error.response.status || statusCode;

            // Modifica qui per includere il nome del file ricevuto dal client nel messaggio di errore
            if (OAIError.message && (
                OAIError.message.toLowerCase().includes("invalid file format") ||
                OAIError.message.toLowerCase().includes("could not be decoded") ||
                OAIError.message.toLowerCase().includes("format is not supported") ||
                (OAIError.code === 'invalid_request_error' && OAIError.message.toLowerCase().includes("supported format"))
            )) {
                 userErrorMessage = `Errore formato per file (nome inviato dal client: '${clientOriginalFilename}', MIME server: '${files?.audio?.[0]?.mimetype || 'N/A'}'): ${OAIError.message}. Formati supportati: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.`;
            }
        } else if (error.message) { // Altri tipi di errore (non specifici di OpenAI)
            userErrorMessage = error.message;
        }

        console.error(`[Transcribe API] FINAL: Responding to client with status ${statusCode} and message: "${userErrorMessage}"`);
        res.status(statusCode).json({ error: userErrorMessage });
    } finally {
        if (tempFilePathForCleanup && fs.existsSync(tempFilePathForCleanup)) {
            fs.unlink(tempFilePathForCleanup, unlinkErr => {
                if (unlinkErr) console.error("[Transcribe API] Error deleting temp file in finally block:", unlinkErr);
                else console.log("[Transcribe API] Temp file deleted:", tempFilePathForCleanup);
            });
        }
    }
}
