/**
 * Multipart parsing with **multer** (memory storage) for App Router `Request`.
 * Multer expects a Node-style readable request; we bridge the Web `ReadableStream` body.
 */

import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import multer from "multer";

/** Max total upload size per request (~80 MB) */
const MAX_BYTES = 80 * 1024 * 1024;

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, fieldSize: 1024 * 1024 },
});

export const uploadFields = upload.fields([
  { name: "images", maxCount: 80 },
  { name: "audio", maxCount: 1 },
  { name: "music", maxCount: 1 },
]);

/** Storyboard sheets only (3×3 grid per image) → `/api/crop-storyboard` */
export const uploadStoryboards = upload.array("storyboards", 48);

/** Batch still images → `/api/upscale-batch` */
export const uploadUpscaleFields = upload.fields([{ name: "upscaleImages", maxCount: 48 }]);

export type ParsedMultipart = {
  images: MulterFile[];
  audio: MulterFile | undefined;
  music: MulterFile | undefined;
};

/** Minimal file shape from multer (avoids pulling in @types/express) */
export type MulterFile = {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
};

function webRequestToIncomingMessage(req: Request, url: string): IncomingMessage {
  if (!req.body) {
    throw new Error("Request has no body (already consumed?)");
  }
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const webStream = req.body as import("stream/web").ReadableStream<Uint8Array>;
  const nodeReadable = Readable.fromWeb(webStream);
  return Object.assign(nodeReadable, {
    headers,
    method: req.method ?? "POST",
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    url,
  }) as IncomingMessage;
}

function stubResponse(): ServerResponse {
  const res = {
    statusCode: 200,
    headersSent: false,
    finished: false,
    setHeader() {},
    getHeader() {
      return undefined;
    },
    writeHead() {},
    end() {},
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
  };
  return res as unknown as ServerResponse;
}

/**
 * Parses `multipart/form-data` using multer. Consumes `req.body` once.
 */
export async function parseMultipartUpload(req: Request): Promise<ParsedMultipart> {
  const incoming = webRequestToIncomingMessage(req, "/api/upload");
  const outgoing = stubResponse();

  await new Promise<void>((resolve, reject) => {
    (uploadFields as unknown as (a: IncomingMessage, b: ServerResponse, c: (e?: unknown) => void) => void)(
      incoming,
      outgoing,
      (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  const fileMap = (incoming as unknown as { files?: Record<string, MulterFile[]> }).files ?? {};
  const images = fileMap.images ?? [];
  const audioArr = fileMap.audio;
  const musicArr = fileMap.music;
  const audio = audioArr?.[0];
  const music = musicArr?.[0];

  return { images, audio, music };
}

export async function parseStoryboardUpload(req: Request): Promise<MulterFile[]> {
  const incoming = webRequestToIncomingMessage(req, "/api/crop-storyboard");
  const outgoing = stubResponse();

  await new Promise<void>((resolve, reject) => {
    (uploadStoryboards as unknown as (a: IncomingMessage, b: ServerResponse, c: (e?: unknown) => void) => void)(
      incoming,
      outgoing,
      (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  const arr = (incoming as unknown as { files?: MulterFile[] }).files;
  return Array.isArray(arr) ? arr : [];
}

export async function parseUpscaleUpload(req: Request): Promise<MulterFile[]> {
  const incoming = webRequestToIncomingMessage(req, "/api/upscale-batch");
  const outgoing = stubResponse();

  await new Promise<void>((resolve, reject) => {
    (uploadUpscaleFields as unknown as (a: IncomingMessage, b: ServerResponse, c: (e?: unknown) => void) => void)(
      incoming,
      outgoing,
      (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  const fileMap = (incoming as unknown as { files?: Record<string, MulterFile[]> }).files ?? {};
  return fileMap.upscaleImages ?? [];
}

export async function parseCaptionVideoUpload(req: Request): Promise<MulterFile | undefined> {
  // Prefer native FormData (stable with App Router). Multer+Readable.fromWeb often
  // surfaces ECONNRESET / "aborted" on video uploads under Turbopack.
  const form = await req.formData();
  const f = form.get("video");
  if (!(f instanceof File) || f.size === 0) return undefined;
  const buffer = Buffer.from(await f.arrayBuffer());
  return {
    fieldname: "video",
    originalname: f.name || "video.mp4",
    encoding: "7bit",
    mimetype: f.type || "video/mp4",
    buffer,
    size: buffer.length,
  };
}
