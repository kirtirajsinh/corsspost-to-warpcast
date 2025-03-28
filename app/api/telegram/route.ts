import { NextResponse } from "next/server";
import axios from "axios";

// Simple regex to find standalone URLs in text
// Note: This will find URLs like https://google.com but NOT the URL part inside [text](url)
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// --- Interface for Telegram Message Entity (simplified) ---
interface TelegramMessageEntity {
    type: 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'url' | 'email' | 'phone_number' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'spoiler' | 'code' | 'pre' | 'text_link' | 'text_mention' | 'custom_emoji';
    offset: number;
    length: number;
    url?: string; // Important for 'text_link' and 'url' types
    // other fields like 'user', 'language', 'custom_emoji_id' might exist
}

// --- Helper Functions ---

// Function to find all standalone URLs in a string
function findStandaloneUrls(text: string): string[] {
    if (!text) return [];
    const matches = text.match(URL_REGEX);
    return matches || []; // Returns an array of found URLs or an empty array
}

// Function to find URLs from Telegram's 'text_link' entities
function findTextLinkUrls(entities: TelegramMessageEntity[] | undefined): string[] {
    if (!entities) return [];
    return entities
        .filter(entity => entity.type === 'text_link' && entity.url)
        .map(entity => entity.url as string); // We know entity.url exists due to the filter
}

// Function to get Telegram file URL
async function getTelegramFileUrl(fileId: unknown): Promise<string | null> {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            console.error("TELEGRAM_BOT_TOKEN is not set.");
            return null;
        }
        if (typeof fileId !== 'string' || !fileId) {
            console.error("Invalid fileId provided:", fileId);
            return null;
        }
        // Step 1: Get file path
        const fileRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
            params: { file_id: fileId }
        });

        if (!fileRes.data || !fileRes.data.ok || !fileRes.data.result || !fileRes.data.result.file_path) {
            console.error("Failed to get file path from Telegram API:", fileRes.data);
            return null;
        }

        const filePath = fileRes.data.result.file_path;
        // Step 2: Generate public file URL
        return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    } catch (error) {
        console.error("Failed to get Telegram file URL:", error instanceof Error ? error.message : error);
        if (axios.isAxiosError(error)) {
            console.error("Axios error details:", error.response?.data);
        }
        return null;
    }
}

function fitToByteLimit(text: string, limit = 1020) {
    const encoder = new TextEncoder();
    const encodedText = encoder.encode(text);

    if (encodedText.length > limit) {
        let truncatedText = text.substring(0, Math.min(text.length, limit));
        while (encoder.encode(truncatedText + '...').length > limit) {
            truncatedText = truncatedText.substring(0, truncatedText.length - 1);
        }
        return truncatedText + '...';
    }

    return text;
}


// Function to post to Warpcast
async function postToWarpcast(text: string, embeds: { url: string }[] | undefined) {
    console.log("Posting to Warpcast. Text:", text, "Embeds:", embeds);
    try {
        const signerUuid = process.env.WARPCAST_SIGNER_UUID;
        const apiKey = process.env.NEYNAR_API_KEY;

        if (!signerUuid || !apiKey) {
            console.error("WARPCAST_SIGNER_UUID or NEYNAR_API_KEY is missing.");
            return { errors: [{ message: "Server configuration error: Missing Warpcast/Neynar credentials." }] };
        }

        const url = "https://api.neynar.com/v2/farcaster/cast";
        const textWithLimit = fitToByteLimit(text);
        const body: {
            signer_uuid: string;
            text: string;
            embeds?: { url: string }[];
        } = {
            signer_uuid: signerUuid,
            // Truncate text if it exceeds Farcaster's limit (e.g., 320 bytes, adjust if needed)
            // A simple character limit is often sufficient, but byte limit is the actual constraint.
            // Be conservative here.
            text: textWithLimit,
        };

        if (embeds && embeds.length > 0) {
            body.embeds = embeds;
        } else {
            console.log("No embeds to include in the cast.");
        }

        console.log("Posting to Warpcast with body:", JSON.stringify(body));

        const response = await fetch(url, {
            method: "POST",
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api_key': apiKey
            },
            body: JSON.stringify(body)
        });

        const jsonResponse = await response.json();

        if (!response.ok || jsonResponse.errors) {
            console.error(`Warpcast API Error (${response.status}):`, jsonResponse);
            return jsonResponse;
        }

        console.log("Warpcast API Success Response:", jsonResponse);
        return jsonResponse;
    } catch (error: unknown) {
        console.error("Failed to post to Warpcast (Network/Fetch Error):", error);
        return { errors: [{ message: `Network or fetch error during Warpcast post: ${error || String(error)}` }] };
    }
}


// --- Main API Route Handler ---
export async function POST(req: Request) {
    try {
        const body = await req.json();
        console.log("Received Telegram post:", JSON.stringify(body, null, 2)); // Pretty print for easier debugging

        if (!body.channel_post) {
            console.log("Ignoring non-channel message");
            return NextResponse.json({ message: "Ignoring non-channel message" });
        }

        const post = body.channel_post;
        const messageText = post.text || post.caption || "";
        // Get entities from either text or caption
        const messageEntities: TelegramMessageEntity[] | undefined = post.entities || post.caption_entities;

        let telegramMediaUrl: string | null = null;

        // Check for media and get its URL
        // Prioritize photo, then video, then document (adjust priority if needed)
        if (post.photo) {
            const fileId = post.photo[post.photo.length - 1].file_id; // Highest resolution
            console.log("Found photo, File ID:", fileId);
            telegramMediaUrl = await getTelegramFileUrl(fileId);
        } else if (post.video) {
            console.log("Found video, File ID:", post.video.file_id);
            telegramMediaUrl = await getTelegramFileUrl(post.video.file_id);
        } else if (post.document && post.document.mime_type?.startsWith('image/')) { // Optional: only embed document if it's an image
            console.log("Found image document, File ID:", post.document.file_id);
            telegramMediaUrl = await getTelegramFileUrl(post.document.file_id);
        } else if (post.document && post.document.mime_type?.startsWith('video/')) { // Optional: only embed document if it's a video
            console.log("Found video document, File ID:", post.document.file_id);
            telegramMediaUrl = await getTelegramFileUrl(post.document.file_id);
        }
        // Add more media types like animation if needed


        // --- URL Extraction ---
        // 1. Extract URLs hidden within text links like [text](url) using entities
        const urlsFromTextLinks = findTextLinkUrls(messageEntities);
        console.log("URLs found from text_links:", urlsFromTextLinks);

        // 2. Extract standalone URLs directly present in the text
        const urlsFromPlainText = findStandaloneUrls(messageText);
        console.log("Standalone URLs found in text:", urlsFromPlainText);


        // --- Embed Selection ---
        const potentialEmbedUrls: string[] = [];

        // Priority 1: Native Telegram Media (if exists and fetched successfully)
        if (telegramMediaUrl) {
            potentialEmbedUrls.push(telegramMediaUrl);
        }

        // Priority 2: URLs from text_links (Markdown-style links)
        potentialEmbedUrls.push(...urlsFromTextLinks);

        // Priority 3: Standalone URLs found in the text
        potentialEmbedUrls.push(...urlsFromPlainText);

        // Deduplicate URLs while preserving the prioritized order somewhat
        // Use a Map to keep the first occurrence (highest priority)
        const uniqueUrlMap = new Map<string, string>();
        potentialEmbedUrls.forEach(url => {
            if (!uniqueUrlMap.has(url)) {
                uniqueUrlMap.set(url, url);
            }
        });
        const uniqueEmbedUrls = Array.from(uniqueUrlMap.values());
        console.log("Unique potential embed URLs (priority order):", uniqueEmbedUrls);

        // Apply Farcaster limit (max 2 embeds)
        const finalEmbedUrls = uniqueEmbedUrls.slice(0, 2);
        console.log("Final embed URLs (max 2):", finalEmbedUrls);

        // Format for Neynar API
        const embedsForApi = finalEmbedUrls.map(url => ({ url: url }));
        console.log("Embeds object for API:", embedsForApi);


        // --- Post to Warpcast ---
        const warpcastResponse = await postToWarpcast(messageText, embedsForApi);
        console.log("Warpcast Response:", warpcastResponse);

        // Check for errors in the Warpcast response
        if (warpcastResponse?.errors) {
            console.error("Warpcast posting failed:", warpcastResponse.errors);
            // Return a 500 status if Warpcast failed
            return NextResponse.json({ success: false, error: "Failed to post to Warpcast", details: warpcastResponse.errors }, { status: 500 });
        }

        return NextResponse.json({ success: true, data: warpcastResponse });

    } catch (error) {
        console.error("Error in POST handler:", error);
        // Log the request body if possible on error, for debugging
        try {
            const bodyText = await req.text(); // Try reading req again as text
            console.error("Request body on error:", bodyText);
        } catch {
            console.error("Could not read request body on error.");
        }
        return NextResponse.json({ success: false, error: "Internal server error processing Telegram post" }, { status: 500 });
    }
}
