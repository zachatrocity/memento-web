import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { db } from '../utils/database';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../../data/downloads');

interface PhotoInfo {
  id: string;
  google_photo_id: string;
  base_url: string;
  width: number;
  height: number;
  mime_type: string;
}

interface DupeGroup {
  ids: string[];
  bestId: string;
}

export class Deduplicator {
  constructor() {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
  }

  async processSessionPhotos(sessionId: string): Promise<{
    originalCount: number;
    duplicateCount: number;
    selectedCount: number;
  }> {
    const database = db.get();
    
    // Get photos for this session
    const photos = database.prepare(
      'SELECT * FROM photos WHERE session_id = ?'
    ).all(sessionId) as PhotoInfo[];

    console.log(`Processing ${photos.length} photos for session ${sessionId}`);

    // Download and analyze each photo
    const analyzedPhotos: Array<PhotoInfo & { hash: string; blurScore: number }> = [];
    
    for (const photo of photos) {
      try {
        const analysis = await this.analyzePhoto(photo);
        analyzedPhotos.push({ ...photo, ...analysis });
      } catch (error) {
        console.error(`Failed to analyze photo ${photo.id}:`, error);
      }
    }

    // Find duplicates using perceptual hashing
    const dupeGroups = this.findDuplicates(analyzedPhotos);
    
    // Mark duplicates and select best from each group
    let selectedCount = 0;
    let duplicateCount = 0;
    
    const updatePhoto = database.prepare(`
      UPDATE photos 
      SET is_dupe = ?, dupe_group_id = ?, is_selected = ?, blur_score = ?
      WHERE id = ?
    `);
    
    const updateDownloadPath = database.prepare(`
      UPDATE photos SET downloaded_path = ? WHERE id = ?
    `);

    for (const group of dupeGroups) {
      const groupId = group.bestId;
      
      for (const id of group.ids) {
        const photo = analyzedPhotos.find(p => p.id === id);
        if (!photo) continue;
        
        const isBest = id === group.bestId;
        const isDupe = group.ids.length > 1 && !isBest;
        
        if (isDupe) duplicateCount++;
        if (isBest || group.ids.length === 1) selectedCount++;
        
        updatePhoto.run(
          isDupe ? 1 : 0,
          groupId,
          isBest ? 1 : 0,
          photo.blurScore,
          id
        );
        
        // Download best photos for video generation
        if (isBest || group.ids.length === 1) {
          const downloadPath = await this.downloadPhoto(photo);
          updateDownloadPath.run(downloadPath, id);
        }
      }
    }

    return {
      originalCount: photos.length,
      duplicateCount,
      selectedCount
    };
  }

  private async analyzePhoto(photo: PhotoInfo): Promise<{ hash: string; blurScore: number }> {
    // Download thumbnail for analysis
    const thumbnailUrl = `${photo.base_url}=w400-h300`;
    const response = await axios.get(thumbnailUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // Generate perceptual hash and calculate blur score
    const image = sharp(buffer);
    const { data } = await image
      .greyscale()
      .normalize()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const hash = this.calculatePHash(data);
    const blurScore = this.calculateBlurScore(data);

    return { hash, blurScore };
  }

  private calculatePHash(data: Buffer): string {
    // Simple perceptual hash using average block comparison
    const size = 8;
    const pixels = data;
    const width = Math.sqrt(pixels.length);
    const blockSize = Math.floor(width / size);
    
    const blocks: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        let count = 0;
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            const px = Math.min(x * blockSize + bx, width - 1);
            const py = Math.min(y * blockSize + by, width - 1);
            sum += pixels[py * width + px];
            count++;
          }
        }
        blocks.push(sum / count);
      }
    }
    
    // Calculate hash from blocks
    const avg = blocks.reduce((a, b) => a + b, 0) / blocks.length;
    const hash = blocks.map(b => b > avg ? '1' : '0').join('');
    
    return hash;
  }

  private calculateBlurScore(data: Buffer): number {
    // Calculate variance of Laplacian as blur metric
    const width = Math.sqrt(data.length);
    let sum = 0;
    let sumSq = 0;
    const laplacian: number[] = [];
    
    // Skip borders
    for (let y = 1; y < width - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const center = data[y * width + x];
        const top = data[(y - 1) * width + x];
        const bottom = data[(y + 1) * width + x];
        const left = data[y * width + (x - 1)];
        const right = data[y * width + (x + 1)];
        
        // Laplacian
        const val = 4 * center - top - bottom - left - right;
        laplacian.push(val);
        sum += val;
        sumSq += val * val;
      }
    }
    
    const n = laplacian.length;
    const mean = sum / n;
    const variance = (sumSq / n) - (mean * mean);
    
    // Higher variance = sharper image
    return Math.sqrt(variance);
  }

  private findDuplicates(photos: Array<PhotoInfo & { hash: string }>): DupeGroup[] {
    const groups: DupeGroup[] = [];
    const processed = new Set<string>();
    
    for (const photo of photos) {
      if (processed.has(photo.id)) continue;
      
      const similar: Array<{ id: string; hash: string; score: number }> = [];
      
      for (const other of photos) {
        if (other.id === photo.id || processed.has(other.id)) continue;
        
        const distance = this.hammingDistance(photo.hash, other.hash);
        if (distance <= 5) { // Threshold for similarity
          similar.push({ id: other.id, hash: other.hash, score: distance });
        }
      }
      
      if (similar.length > 0) {
        // Group all similar photos
        const groupIds = [photo.id, ...similar.map(s => s.id)];
        
        // Find best photo (largest dimensions, lowest blur)
        const groupPhotos = photos.filter(p => groupIds.includes(p.id));
        const best = groupPhotos.reduce((best, current) => {
          const bestPixels = best.width * best.height;
          const currentPixels = current.width * current.height;
          const currentBlur = (current as any).blurScore || 0;
          const bestBlur = (best as any).blurScore || 0;
          
          // Prefer larger images with lower blur (higher blur score = sharper)
          if (currentPixels > bestPixels || 
              (currentPixels === bestPixels && currentBlur > bestBlur)) {
            return current;
          }
          return best;
        });
        
        groups.push({ ids: groupIds, bestId: best.id });
        groupIds.forEach(id => processed.add(id));
      } else {
        groups.push({ ids: [photo.id], bestId: photo.id });
        processed.add(photo.id);
      }
    }
    
    return groups;
  }

  private hammingDistance(a: string, b: string): number {
    let distance = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) distance++;
    }
    return distance;
  }

  private async downloadPhoto(photo: PhotoInfo): Promise<string> {
    const filename = `${photo.id}.jpg`;
    const filepath = path.join(DOWNLOAD_DIR, filename);
    
    if (fs.existsSync(filepath)) {
      return filepath;
    }
    
    // Download full resolution
    const downloadUrl = `${photo.base_url}=d`;
    const response = await axios.get(downloadUrl, { responseType: 'stream' });
    
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });
    
    return filepath;
  }
}
