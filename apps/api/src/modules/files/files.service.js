import { randomUUID } from 'node:crypto';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../utils/errors.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Documents, images and archives people attach to work. Executable and script types are refused.
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function safeName(name) {
  return name.replace(/[\\/\0\r\n]/g, '_').slice(0, 255) || 'file';
}

/** File metadata lifecycle: presign (PENDING) → verify upload (READY) → signed access → delete. */
export function createFileService({ prisma, storage }) {
  return {
    async presignUpload(db, ctx, { purpose, fileName, contentType, sizeBytes }) {
      if (!ALLOWED_TYPES.has(contentType)) throw new ValidationError([{ path: 'body.contentType', message: 'This file type is not allowed' }]);
      if (sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) {
        throw new ValidationError([{ path: 'body.sizeBytes', message: `Files must be between 1 byte and ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }]);
      }
      const id = randomUUID();
      const storageKey = `files/${ctx.orgId}/${purpose}/${id}`;
      const file = await db.fileObject.create({
        data: { organizationId: ctx.orgId, storageKey, originalName: safeName(fileName), mimeType: contentType, sizeBytes, purpose, uploadedById: ctx.userId },
      });
      const upload = await storage.presignPut({ bucket: storage.buckets.files, key: storageKey, contentType, contentLength: sizeBytes });
      return { file, upload };
    },

    /** Verifies the object exists with the declared size and type before marking it READY. */
    async verifyUpload(db, ctx, fileId) {
      const file = await db.fileObject.findFirst({ where: { organizationId: ctx.orgId, id: fileId, uploadedById: ctx.userId } });
      if (!file) throw new NotFoundError('File not found');
      if (file.status === 'READY') return file;
      const head = await storage.head({ bucket: storage.buckets.files, key: file.storageKey });
      if (!head) throw new BusinessRuleError('The upload has not finished yet');
      if (head.contentLength !== file.sizeBytes || (head.contentType && head.contentType !== file.mimeType)) {
        await storage.remove({ bucket: storage.buckets.files, key: file.storageKey }).catch(() => {});
        await db.fileObject.updateMany({ where: { organizationId: ctx.orgId, id: fileId }, data: { status: 'DELETED' } });
        throw new BusinessRuleError('The uploaded file does not match what was declared');
      }
      await db.fileObject.updateMany({ where: { organizationId: ctx.orgId, id: fileId }, data: { status: 'READY' } });
      return { ...file, status: 'READY' };
    },

    accessUrl(file) {
      return storage.presignGet({ bucket: storage.buckets.files, key: file.storageKey, fileName: file.originalName });
    },

    async remove(db, ctx, file) {
      await db.fileObject.updateMany({ where: { organizationId: ctx.orgId, id: file.id }, data: { status: 'DELETED' } });
      await storage.remove({ bucket: storage.buckets.files, key: file.storageKey }).catch(() => {});
    },

    serialize: (f) => ({ id: f.id, name: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, status: f.status, uploadedById: f.uploadedById, createdAt: f.createdAt }),
    prisma,
  };
}
