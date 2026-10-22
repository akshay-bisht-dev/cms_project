import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_TTL_S = 300;
const DOWNLOAD_TTL_S = 60;

/**
 * Private object storage (S3-compatible). Browsers upload and download directly with short-lived
 * signed URLs; the API only signs, verifies and records metadata (ADR D9).
 */
export function createStorage(env) {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });

  return {
    client,
    buckets: { captures: env.S3_BUCKET_CAPTURES, files: env.S3_BUCKET_FILES },

    async ping() {
      await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET_FILES }));
    },

    /** Signed PUT bound to the declared type and size (S3 rejects a different Content-Length). */
    async presignPut({ bucket, key, contentType, contentLength }) {
      const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), {
        expiresIn: UPLOAD_TTL_S,
      });
      return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000).toISOString() };
    },

    async presignGet({ bucket, key, fileName, inline = false }) {
      const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition }), {
        expiresIn: DOWNLOAD_TTL_S,
      });
      return { url, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() };
    },

    /** Object metadata, or null when it does not exist. */
    async head({ bucket, key }) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { contentLength: res.ContentLength, contentType: res.ContentType };
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
        throw err;
      }
    },

    /** Reads a whole object into memory (screenshots are bounded to a few MB). */
    async getObject({ bucket, key }) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },

    async putObject({ bucket, key, body, contentType }) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
    },

    async remove({ bucket, key }) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    destroy() {
      client.destroy();
    },
  };
}
