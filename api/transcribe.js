// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable';
import fs from 'fs';
import { toFile } from 'openai/uploads';

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

    try {
        const [fields, files] = await form.parse(req);
        const audioFileArray = files.audio;

        if (!audioFileArray || audioFileArray.length === 0) {
            return res.status(400).json({ error: 'No audio file uploaded.' });
        }

        const uploadedFile = audioFileArray[0];
        tempFilePathForCleanup = uploadedFile.filepath;

        const originalFilename = uploadedFile.originalFilename || 'audio.unknown';

        console.log('--- Transcribe API ---');
        console.log('Received Upload:');
        console.log('  Original Filename (from client):', originalFilename);
        console.log('  Mimetype (detected by formidable):', uploadedFile.mimetype);
        console.log('  Temporary file path:', tempFilePathForCleanup);
        console.log('  File size:', uploadedFile.size);
        console.log('----------------------');

        if (uploadedFile.size === 0) {
            console.error("Uploaded file is empty.");
            return res.status(400).json({ error: 'Audio file is empty.' });
        }

        console.log('Preparing file for OpenAI using filename for type inference:', originalFilename);

        const fileForOpenAI = await toFile(
            fs.createReadStream(tempFilePathForCleanup),
            originalFilename
        );

        const transcription = await openai.audio.transcriptions.create({
            file: fileForOpenAI,
            model: "whisper-1",
            language: "it",
            response_format: "json",
        });

        console.log('Whisper Transcription successful:', transcription.text);
        res.status(200).json({ transcript: transcription.text });

    } catch (error) {
        console.error('Full error object in /api/transcribe:', error);
        let userErrorMessage = 'Errore durante la trascrizione.';
        let statusCode = 500;

        if (error.status && typeof error.status === 'number') {
            statusCode = error.status;
        }

        if (error.response && error.response.data && error.response.data.error) {
            const OAIError = error.response.data.error;
            console.error('OpenAI API Error Details:', JSON.stringify(OAIError, null, 2));
            
            userErrorMessage = OAIError.message || 'Errore sconosciuto da API OpenAI.';
            if (OAIError.code) {
                userErrorMessage = `[OpenAI Code: ${OAIError.code}] ${userErrorMessage}`;
            }
            statusCode = error.response.status || statusCode;

            if (OAIError.message && (
                OAIError.message.toLowerCase().includes("invalid file format") ||
                OAIError.message.toLowerCase().includes("could not be decoded") ||
                OAIError.message.toLowerCase().includes("format is not supported") ||
                (OAIError.code === 'invalid_request_error' && OAIError.message.toLowerCase().includes("supported format"))
            )) {
                 userErrorMessage = `[OpenAI Code: ${OAIError.code}] Formato file audio non valido o non riconosciuto da OpenAI. Dettaglio OpenAI: "${OAIError.message}". Formati supportati: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.`;
            }
        } else if (error.message) {
            userErrorMessage = error.message;
            if (statusCode === 500 && error.httpCode && typeof error.httpCode === 'number') {
                 statusCode = error.httpCode;
            }
            if (error.code === 'ENOENT') {
                userErrorMessage = `Errore file system (server): ${error.message}`;
            } else if (error.name === 'AbortError') {
                 userErrorMessage = `Richiesta a OpenAI interrotta o timeout. Dettaglio: ${error.message}`;
                 statusCode = 504;
            }
        }

        console.error(`FINAL: Responding to client with status ${statusCode} and message: "${userErrorMessage}"`);
        res.status(statusCode).json({ error: userErrorMessage });
    } finally {
        if (tempFilePathForCleanup && fs.existsSync(tempFilePathForCleanup)) {
            fs.unlink(tempFilePathForCleanup, unlinkErr => {
                if (unlinkErr) console.error("Error deleting temp file in finally block:", unlinkErr);
                else console.log("Temp file deleted:", tempFilePathForCleanup);
            });
        }
    }
}
