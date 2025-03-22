import { NextResponse } from "next/server";
import axios from "axios";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        console.log("Received Telegram post:", body);

        // Only process channel posts (ignore bot messages)
        if (!body.channel_post) {
            return NextResponse.json({ message: "Ignoring non-channel message" });
        }

        const post = body.channel_post;
        const messageText = post.text || post.caption || ""; // Text or caption
        let mediaUrl = null;

        // Check if media exists
        if (post.photo) {
            // Get the highest resolution photo
            const fileId = post.photo[post.photo.length - 1].file_id;
            console.log("File ID:", fileId, typeof fileId);
            mediaUrl = await getTelegramFileUrl(fileId);
        } else if (post.video) {
            mediaUrl = await getTelegramFileUrl(post.video.file_id);
        } else if (post.document) {
            mediaUrl = await getTelegramFileUrl(post.document.file_id);
        }

        // Post to Warpcast using the function
        const warpcastResponse = await postToWarpcast(messageText, mediaUrl || '');
        console.log("Warpcast Response:", warpcastResponse);

        return NextResponse.json({ success: true, data: warpcastResponse });
    } catch (error) {
        console.error("Error:", error);
        return NextResponse.json({ error: "Failed to post" }, { status: 500 });
    }
}
// Function to get Telegram file URL
async function getTelegramFileUrl(fileId: unknown) {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        // Step 1: Get file path
        const fileRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        // Step 2: Generate public file URL
        return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    } catch (error) {
        console.error("Failed to get Telegram file URL:", error);
        return null;
    }
}
async function postToWarpcast(text: string, mediaUrl: string) {
    console.log("Posting to Warpcast with text:", text, "and mediaUrl:", mediaUrl);
    try {
        const url = "https://api.neynar.com/v2/farcaster/cast";
        const body = {
            signer_uuid: process.env.WARPCAST_SIGNER_UUID,
            text: text,
            embeds: mediaUrl ? [{ url: mediaUrl }] : undefined
        };

        console.log("Posting to Warpcast with body:", body);

        const response = await fetch(url, {
            method: "POST",
            headers: new Headers({
                accept: "application/json",
                "content-type": "application/json",
                "x-api-key": process.env.NEYNAR_API_KEY || ''
            }),
            body: JSON.stringify(body)
        });

        const jsonResponse = await response.json();
        console.log("Warpcast API Response:", jsonResponse);
        return jsonResponse;
    } catch (error) {
        console.error("Failed to post to Warpcast:", error);
        return null;
    }
}