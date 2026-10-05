const axios = require('axios');
const pool = require('../../../db');

const WHATSAPP_API_VERSION =
    process.env.WHATSAPP_API_VERSION || 'v23.0';

const WHATSAPP_PHONE_NUMBER_ID =
    process.env.WHATSAPP_PHONE_NUMBER_ID;

const WHATSAPP_ACCESS_TOKEN =
    process.env.WHATSAPP_ACCESS_TOKEN;

const WHATSAPP_API_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

/**
 * إرسال رسالة نصية عبر WhatsApp Cloud API
 */

async function saveOutgoingWhatsAppMessage({
    to,
    messageId,
    messageType,
    messageText,
    payload
}) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const conversationResult = await client.query(
            `
            INSERT INTO whatsapp_conversations
                (wa_id, customer_name, last_message_text, last_message_at, updated_at)
            VALUES
                ($1, NULL, $2, NOW(), NOW())
            ON CONFLICT (wa_id)
            DO UPDATE SET
                last_message_text = EXCLUDED.last_message_text,
                last_message_at = NOW(),
                updated_at = NOW()
            RETURNING id
            `,
            [to, messageText || null]
        );

        const conversationId = conversationResult.rows[0].id;

        if (messageId) {
            await client.query(
                `
                INSERT INTO whatsapp_messages
                    (
                        conversation_id,
                        whatsapp_message_id,
                        direction,
                        message_type,
                        message_text,
                        payload,
                        status
                    )
                VALUES
                    ($1, $2, 'OUTBOUND', $3, $4, $5::jsonb, 'SENT')
                ON CONFLICT (whatsapp_message_id)
                DO NOTHING
                `,
                [
                    conversationId,
                    messageId,
                    messageType || 'unknown',
                    messageText || null,
                    JSON.stringify(payload || {})
                ]
            );
        } else {
            await client.query(
                `
                INSERT INTO whatsapp_messages
                    (
                        conversation_id,
                        direction,
                        message_type,
                        message_text,
                        payload,
                        status
                    )
                VALUES
                    ($1, 'OUTBOUND', $2, $3, $4::jsonb, 'SENT')
                `,
                [
                    conversationId,
                    messageType || 'unknown',
                    messageText || null,
                    JSON.stringify(payload || {})
                ]
            );
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(
            'WhatsApp outgoing message save error:',
            error.message
        );
    } finally {
        client.release();
    }
}

async function sendTextMessage(to, message) {
    if (!WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error('WHATSAPP_PHONE_NUMBER_ID غير مضبوط');
    }

    if (!WHATSAPP_ACCESS_TOKEN) {
        throw new Error('WHATSAPP_ACCESS_TOKEN غير مضبوط');
    }

    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'text',
                text: {
                    preview_url: false,
                    body: message
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await saveOutgoingWhatsAppMessage({
            to,
            messageId: response.data?.messages?.[0]?.id,
            messageType: 'text',
            messageText: message,
            payload: response.data
        });
        return response.data;
    } catch (error) {
        const details =
            error.response?.data || error.message;

        console.error(
            'WhatsApp API Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}


/**
 * إرسال زر رابط مباشر عبر WhatsApp Cloud API
 */
async function sendUrlButtonMessage(to, body, buttonText, url) {
    if (!WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error('WHATSAPP_PHONE_NUMBER_ID غير مضبوط');
    }

    if (!WHATSAPP_ACCESS_TOKEN) {
        throw new Error('WHATSAPP_ACCESS_TOKEN غير مضبوط');
    }

    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'interactive',
                interactive: {
                    type: 'cta_url',
                    body: {
                        text: body
                    },
                    action: {
                        name: 'cta_url',
                        parameters: {
                            display_text: buttonText,
                            url
                        }
                    }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await saveOutgoingWhatsAppMessage({
            to,
            messageId: response.data?.messages?.[0]?.id,
            messageType: 'interactive_url',
            messageText: body,
            payload: response.data
        });
        return response.data;
    } catch (error) {
        const details = error.response?.data || error.message;

        console.error(
            'WhatsApp CTA URL Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}


/**
 * إرسال بطاقة اتصال الموظف عبر WhatsApp Cloud API
 */
async function sendTemplateMessage(to, templateName, languageCode = 'ar', bodyParameters = []) {
    try {
        const template = {
            name: templateName,
            language: {
                code: languageCode
            }
        };

        const components = [];

        if (bodyParameters.length > 0) {
            components.push({
                type: 'body',
                parameters: bodyParameters.map(value => ({
                    type: 'text',
                    text: String(value)
                }))
            });
        }

        if (templateName === 'muluk_royal_offer_booking') {
            components.push({
                type: 'button',
                sub_type: 'flow',
                index: '0',
                parameters: [
                    {
                        type: 'action',
                        action: {
                            flow_token: `MULUK_${Date.now()}_${String(to).replace(/\D/g, '')}`
                        }
                    }
                ]
            });
        }

        if (components.length > 0) {
            template.components = components;
        }

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v23.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to,
                type: 'template',
                template
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await saveOutgoingWhatsAppMessage({
            to,
            messageId: response.data?.messages?.[0]?.id,
            messageType: 'template',
            messageText: `Template: ${templateName}`,
            payload: response.data
        });

        return response.data;

    } catch (error) {
        const details = error.response?.data || error.message;

        console.error(
            'WhatsApp Template Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}

async function sendContactMessage(to, phone, name) {
    if (!WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error('WHATSAPP_PHONE_NUMBER_ID غير مضبوط');
    }

    if (!WHATSAPP_ACCESS_TOKEN) {
        throw new Error('WHATSAPP_ACCESS_TOKEN غير مضبوط');
    }

    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'contacts',
                contacts: [
                    {
                        name: {
                            formatted_name: name,
                            first_name: name
                        },
                        phones: [
                            {
                                phone: phone,
                                type: 'WORK'
                            }
                        ]
                    }
                ]
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await saveOutgoingWhatsAppMessage({
            to,
            messageId: response.data?.messages?.[0]?.id,
            messageType: 'contact',
            messageText: name || phone,
            payload: response.data
        });
        return response.data;
    } catch (error) {
        const details = error.response?.data || error.message;

        console.error(
            'WhatsApp Contact Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}

/**
 * تنزيل صورة من WhatsApp Cloud API وحفظها محليًا
 */
async function downloadWhatsAppMedia(mediaId, filePath) {
    if (!WHATSAPP_ACCESS_TOKEN) {
        throw new Error('WHATSAPP_ACCESS_TOKEN غير مضبوط');
    }

    if (!mediaId) {
        throw new Error('معرف الوسائط غير موجود');
    }

    try {
        const mediaInfo = await axios.get(
            `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
                }
            }
        );

        const mediaUrl = mediaInfo.data?.url;

        if (!mediaUrl) {
            throw new Error('تعذر الحصول على رابط صورة WhatsApp');
        }

        const imageResponse = await axios.get(
            mediaUrl,
            {
                responseType: 'arraybuffer',
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
                }
            }
        );

        const fs = require('fs');

        fs.writeFileSync(
            filePath,
            Buffer.from(imageResponse.data)
        );

        return {
            mediaId,
            mimeType: mediaInfo.data?.mime_type || imageResponse.headers['content-type'] || null,
            filePath,
            sha256: mediaInfo.data?.sha256 || null
        };
    } catch (error) {
        const details = error.response?.data || error.message;

        console.error(
            'WhatsApp Media Download Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}


/**
 * إرسال صورة عبر WhatsApp Cloud API باستخدام Media ID
 */
async function sendImageMessage(to, mediaId, caption = '') {
    if (!WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error('WHATSAPP_PHONE_NUMBER_ID غير مضبوط');
    }

    if (!WHATSAPP_ACCESS_TOKEN) {
        throw new Error('WHATSAPP_ACCESS_TOKEN غير مضبوط');
    }

    if (!mediaId) {
        throw new Error('WhatsApp media ID غير موجود');
    }

    try {
        const imagePayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'image',
            image: {
                id: mediaId
            }
        };

        if (caption) {
            imagePayload.image.caption = caption;
        }

        const response = await axios.post(
            WHATSAPP_API_URL,
            imagePayload,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await saveOutgoingWhatsAppMessage({
            to,
            messageId: response.data?.messages?.[0]?.id,
            messageType: 'image',
            messageText: caption || null,
            payload: response.data
        });

        return response.data;
    } catch (error) {
        const details =
            error.response?.data || error.message;

        console.error(
            'WhatsApp Image API Error:',
            JSON.stringify(details, null, 2)
        );

        throw error;
    }
}

module.exports = {
    saveOutgoingWhatsAppMessage,
    sendTextMessage,
    sendUrlButtonMessage,
    sendContactMessage,
    sendTemplateMessage,
    sendImageMessage,
    downloadWhatsAppMedia
};
