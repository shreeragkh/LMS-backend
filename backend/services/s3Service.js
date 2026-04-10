const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const region = process.env.AWS_REGION;

const s3 = new S3Client({
  region,
  credentials: accessKeyId && secretAccessKey
    ? {
        accessKeyId,
        secretAccessKey
      }
    : undefined
});

function getCandidateBuckets() {
  const buckets = [process.env.AWS_BUCKET, process.env.AWS_S3_BUCKET]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const uniqueBuckets = [...new Set(buckets)];
  if (uniqueBuckets.length === 0) {
    throw new Error("S3 bucket is not configured (set AWS_S3_BUCKET or AWS_BUCKET)");
  }

  return uniqueBuckets;
}

async function uploadBufferToS3({ buffer, key, contentType }) {
  const buckets = getCandidateBuckets();
  let lastError;

  for (const bucket of buckets) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || "application/octet-stream"
      }));

      const publicUrl = process.env.AWS_S3_PUBLIC_URL
        ? `${process.env.AWS_S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`
        : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

      return { bucket, key, url: publicUrl };
    } catch (error) {
      lastError = error;

      // If one configured bucket doesn't exist, try next configured bucket.
      if (error?.name === "NoSuchBucket") {
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("S3 upload failed");
}

async function deleteObjectFromS3({ key }) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) {
    throw new Error("S3 key is required for deletion");
  }

  const buckets = getCandidateBuckets();
  let lastError;

  for (const bucket of buckets) {
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: cleanKey
      }));

      return { bucket, key: cleanKey };
    } catch (error) {
      lastError = error;

      // If object/bucket is missing in one bucket candidate, try next.
      if (error?.name === "NoSuchKey" || error?.name === "NoSuchBucket") {
        continue;
      }

      throw error;
    }
  }

  // Treat missing object as already deleted.
  if (lastError?.name === "NoSuchKey" || lastError?.name === "NoSuchBucket") {
    return { bucket: null, key: cleanKey };
  }

  throw lastError || new Error("S3 deletion failed");
}

module.exports = { uploadBufferToS3, deleteObjectFromS3 };
