# 🧪 Test Lokalt (Uden Database)

## Quick start

### 1. Install
```powershell
npm install
```

### 2. Create `.env` fil
```powershell
Copy-Item .env.example .env
notepad .env
```

Tilføj denne linje:
```env
TEST_MODE=true
PORT=10000
```

### 3. Start server
```powershell
npm start
```

Du bør se:
```
[TEST MODE] 🧪 Running in test mode - files will be saved locally instead of Supabase
✅ ContentMølle backend on :10000
```

### 4. Test med video

**Download en test video:**
```powershell
# Eller brug en af dine egne .mp4 filer
$testVideo = "C:\Users\rasmu\Desktop\test.mp4"
```

**Upload via curl:**
```powershell
cmd /c curl -X POST http://localhost:10000/molle `
  -F "videos=@$testVideo" `
  -F "videos=@$testVideo" `
  -F "videos=@$testVideo" `
  -F "level=1" `
  -F "noCaptionMode=false"
```

### 5. Tjek output

**Console output viser randomization:**
```
[FFmpeg L1] clip 0: contrast=1.0143, sat=1.0082, bright=0.0051, crf=24, preset=veryfast, trim=157ms, audio=volume=1.003,highpass=f=20
[FFmpeg L1] clip 1: contrast=1.0097, sat=1.0038, bright=0.0029, crf=23, preset=faster, trim=89ms, audio=volume=0.997
[FFmpeg L1] clip 2: contrast=1.0118, sat=1.0051, bright=0.0063, crf=25, preset=superfast, trim=42ms, audio=volume=1.008
```

**✅ Værdierne er forskellige = randomization virker!**

**Filer gemt i:**
```
C:\Users\rasmu\AppData\Local\Temp\content-molle-test-output\
```

**Response JSON:**
```json
{
  "ok": true,
  "batchId": "batch_abc123",
  "count": 3,
  "csv_url": "file:///C:/Users/rasmu/AppData/Local/Temp/content-molle-test-output/batches_batch_abc123_captions.csv",
  "results": [
    {
      "idx": 0,
      "output_url": "file:///C:/Users/rasmu/AppData/Local/Temp/...",
      "caption": "That icy hit when you least expect it 🧊",
      "hashtags": ["#fyp", "#viral", "#ice", "#mint"]
    }
  ]
}
```

## Hvad tester dette?

✅ **Video processing** - FFmpeg randomization virker  
✅ **Caption generation** - Forskellige captions per video  
✅ **Hashtag shuffle** - Forskellige hashtags order  
✅ **CSV generation** - Med shuffle enabled  
❌ **Supabase upload** - Skippet i test mode  

## Test CSV shuffle

Upload samme videos 2 gange, sammenlign CSV'erne:

```powershell
# Request 1
cmd /c curl -X POST http://localhost:10000/molle `
  -F "videos=@test.mp4" `
  -F "videos=@test.mp4" `
  -o result1.json

# Request 2
cmd /c curl -X POST http://localhost:10000/molle `
  -F "videos=@test.mp4" `
  -F "videos=@test.mp4" `
  -o result2.json

# Sammenlign results - rækkefølge skal være forskellig!
```

## Cleanup test files

```powershell
Remove-Item "$env:TEMP\content-molle-test-output" -Recurse -Force
```

## Skift til production mode

**I `.env` fil:**
```env
TEST_MODE=false  # eller fjern linjen helt
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...
```

Restart serveren - nu uploader den til Supabase for real! 🚀
