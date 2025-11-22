import { Router, Request, Response } from 'express';
import { PayTechNotification, CustomField } from '../types/paytech';
import { supabase } from '../config/supabase';
import { sha256 } from '../utils/crypto';

// Node 18+ fournit fetch globalement, on le déclare pour TypeScript
declare const fetch: any;

const router = Router();

async function handleWebhook(req: Request, res: Response) {
    console.log('=== WEBHOOK HANDLER STARTED ===');
    
    try {
        // Parse les données reçues
        const notificationData = req.headers['content-type']?.includes('application/x-www-form-urlencoded')
            ? req.body
            : typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        console.log('Received notification data:', notificationData);

        const notification = notificationData as PayTechNotification;
        
        // Parse custom_field
        let customField: CustomField;
        try {
            customField = typeof notification.custom_field === 'string'
                ? JSON.parse(notification.custom_field)
                : notification.custom_field;

            if (!customField.ref_command) {
                throw new Error('Missing ref_command in custom_field');
            }

            console.log('Parsed custom field:', customField);
        } catch (e) {
            console.error('Error parsing custom_field:', e);
            return res.status(400).json({ error: 'Invalid custom_field format' });
        }

        if (notification.type_event !== 'sale_complete') {
            console.log('Ignoring non-sale event:', notification.type_event);
            return res.status(200).json({ status: 'ignored' });
        }

        // Vérification des signatures
        const myApiKey = process.env.PAYTECH_API_KEY!;
        const myApiSecret = process.env.PAYTECH_API_SECRET!;
        
        const apiKeyHash = sha256(myApiKey);
        const apiSecretHash = sha256(myApiSecret);

        console.log('Signature verification:', {
            received_key_hash: notification.api_key_sha256,
            calculated_key_hash: apiKeyHash,
            matches: apiKeyHash === notification.api_key_sha256
        });

        if (
            apiKeyHash !== notification.api_key_sha256 || 
            apiSecretHash !== notification.api_secret_sha256
        ) {
            console.error('Invalid signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Récupération de l'achat en attente
        const { data: pendingPurchase, error: fetchError } = await supabase
            .from('purchases_pending')
            .select('*')
            .eq('ref_command', customField.ref_command)
            .single();

        console.log('Found pending purchase:', pendingPurchase);

        if (fetchError || !pendingPurchase) {
            console.error('Pending purchase not found for ref_command:', customField.ref_command, fetchError);
            return res.status(404).json({ error: 'Pending purchase not found' });
        }

        // Création de l'achat confirmé à partir de la ligne pending
        const confirmedPurchase = {
            user_id: pendingPurchase.user_id,
            music_id: pendingPurchase.music_id,
            amount: pendingPurchase.amount,
            payment_status: 'completed',
            payment_method: notification.payment_method,
            payment_ref: notification.ref_command,
            client_phone: notification.client_phone,
            payment_details: notification,
            ref_command: customField.ref_command,
            created_at: pendingPurchase.created_at,
            updated_at: new Date().toISOString()
        };

        console.log('Preparing confirmed purchase:', confirmedPurchase);

        // Insertion dans purchases
        const { error: insertError } = await supabase
            .from('purchases')
            .insert([confirmedPurchase]);

        if (insertError) {
            console.error('Insert error when creating purchase:', insertError);
            return res.status(500).json({ error: 'Insert failed' });
        }

        // Suppression de purchases_pending
        await supabase
            .from('purchases_pending')
            .delete()
            .eq('ref_command', customField.ref_command);

        console.log('Webhook processing completed successfully');
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Webhook processing error:', error);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
}

// Création d'un paiement PayTech
async function createPayment(req: Request, res: Response) {
    try {
        const { user_id, music_id } = req.body;

        if (!user_id || !music_id) {
            return res.status(400).json({ error: 'user_id and music_id are required' });
        }

        // Récupérer les infos de la musique (prix, titre)
        const { data: music, error: musicError } = await supabase
            .from('musics')
            .select('id, title, price')
            .eq('id', music_id)
            .single();

        if (musicError || !music) {
            console.error('Music not found for payment:', musicError);
            return res.status(404).json({ error: 'Music not found' });
        }

        if (!music.price || Number(music.price) <= 0) {
            return res.status(400).json({ error: 'Invalid music price' });
        }

        const amount = Number(music.price);

        // Générer une référence unique pour la commande
        const ref_command = `${music_id}-${Date.now()}`;

        // Créer la ligne en attente dans purchases_pending
        const { error: pendingError } = await supabase
            .from('purchases_pending')
            .insert([
                {
                    user_id,
                    music_id,
                    amount,
                    payment_status: 'pending',
                    ref_command,
                },
            ]);

        if (pendingError) {
            console.error('Error inserting purchases_pending:', pendingError);
            return res.status(500).json({ error: 'Failed to create pending purchase' });
        }

        const apiKey = process.env.PAYTECH_API_KEY;
        const apiSecret = process.env.PAYTECH_API_SECRET;
        const frontendUrl = process.env.FRONTEND_URL;
        const ipnUrl = process.env.PAYTECH_IPN_URL;

        if (!apiKey || !apiSecret) {
            console.error('Missing PAYTECH_API_KEY or PAYTECH_API_SECRET env vars');
            return res.status(500).json({ error: 'PayTech configuration error' });
        }

        if (!frontendUrl) {
            console.error('Missing FRONTEND_URL env var');
            return res.status(500).json({ error: 'Frontend URL not configured' });
        }

        if (!ipnUrl) {
            console.error('Missing PAYTECH_IPN_URL env var');
            return res.status(500).json({ error: 'PAYTECH_IPN_URL not configured' });
        }

        // Préparer la requête vers l'API PayTech
        const paytechPayload = {
            item_name: music.title,
            item_price: amount.toString(),
            command_name: `Achat musique ${music.id}`,
            ref_command,
            currency: 'XOF',
            env: process.env.PAYTECH_ENV || 'test',
            ipn_url: ipnUrl,
            success_url: `${frontendUrl}/payment/success?ref=${encodeURIComponent(ref_command)}`,
            cancel_url: `${frontendUrl}/payment/cancel?ref=${encodeURIComponent(ref_command)}`,
            custom_field: JSON.stringify({ ref_command }),
        };

        console.log('Sending PayTech payment request with payload:', paytechPayload);

        const paytechResponse = await fetch('https://paytech.sn/api/payment/request-payment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'API_KEY': apiKey,
                'API_SECRET': apiSecret,
            },
            body: JSON.stringify(paytechPayload),
        });

        const paytechData = await paytechResponse.json();
        console.log('PayTech API response:', paytechData);

        if (!paytechResponse.ok) {
            console.error('PayTech request failed:', paytechData);
            return res.status(502).json({ error: 'PayTech request failed', details: paytechData });
        }

        const paymentUrl = paytechData.redirect_url || paytechData.url || paytechData.payment_url;

        if (!paymentUrl) {
            console.error('No payment URL returned by PayTech');
            return res.status(502).json({ error: 'Invalid PayTech response, missing payment URL' });
        }

        return res.status(200).json({
            payment_url: paymentUrl,
            ref_command,
        });
    } catch (error) {
        console.error('Error in createPayment handler:', error);
        return res.status(500).json({ error: 'Create payment failed' });
    }
}

// Routes
router.post('/ipn', handleWebhook);
router.post('/create-payment', createPayment);
router.get('/health', (_, res) => res.status(200).json({ status: 'healthy' }));

export default router;