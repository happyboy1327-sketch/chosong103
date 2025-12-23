import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import yauzl from 'yauzl';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 8080;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const ZIP_PATH = path.join(__dirname, 'dict.zip');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const POOL_REF = db.ref('quiz_pool');

app.use(cors());
app.use(express.static(path.join(process.cwd(), "public")));

// =====================
// 초성 추출
// =====================
const CHOSUNG_LIST = [
  'ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ',
  'ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'
];

function getChosung(text){
  const result = [];
  for (let char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      result.push(CHOSUNG_LIST[Math.floor((code - 0xAC00)/588)]);
    }
  }
  return result;
}

// =====================
// =====================
// 힌트 추출
// =====================
// 힌트 추출
// =====================
function extractHint(posInfo, wordInfo) {
  if (!posInfo) return null;
  
  const hints = [];
  
  // 속담 처리
  if (wordInfo?.word_unit === "속담") {
    for (const pos of posInfo) {
      if (!pos.comm_pattern_info) continue;
      for (const comm of pos.comm_pattern_info) {
        if (!comm.sense_info) continue;
        for (const sense of comm.sense_info) {
          let hint = sense.definition || sense.definition_original;
          if (hint) {
            hint = hint.replace(/<[^>]*>/g, "")
                       .replace(/\d{5,}/g, "")
                       .replace(/'[^']*'/g, "")
                       .replace(/[_\[\]「」『』()]/g, " ")
                       .replace(/\s+/g, " ")
                       .trim();
            if (hint.length >= 5 && hint.length <= 200) {
              hints.push("속담: " + hint);
            }
          }
        }
      }
    }
    if (hints.length > 0) {
      return hints.length === 1 ? hints[0] : hints.map((h, i) => `${i + 1}. ${h}`).join(" / ");
    }
  }
  
  // 일반 단어 - 모든 뜻 수집
  for (const pos of posInfo) {
    if (!pos.comm_pattern_info) continue;
    for (const comm of pos.comm_pattern_info) {
      if (!comm.sense_info) continue;
      for (const sense of comm.sense_info) {
        let hint = sense.definition_original;
        if (!hint) continue;
        
        hint = hint.replace(/<[^>]*>/g, "")
                   .replace(/\d{5,}/g, "")
                   .replace(/'[^']*'/g, "")
                   .replace(/[_\[\]「」『』()]/g, " ")
                   .replace(/\s+/g, " ")
                   .trim();
        
        if (hint.length >= 1 && hint.length <= 160 && 
            !/^\d+$/.test(hint) && 
            !hint.includes("<") && 
            !hint.includes(">")) {
          // 중복 제거
          if (!hints.includes(hint)) {
            hints.push(hint);
          }
        }
      }
    }
  }
  
  // ✅ 디버깅용 로그 추가
  if (wordInfo?.word) {
    console.log(`📝 [${wordInfo.word}] 찾은 뜻 개수: ${hints.length}`);
    console.log(`📝 [${wordInfo.word}] 뜻 목록:`, hints);
  }
  
  // 결과 반환
  if (hints.length === 0) return null;
  if (hints.length === 1) return hints[0];
  return hints.map((h, i) => `${i + 1}. ${h}`).join(" / ");
}
// =====================
// 단어 필터링
// =====================
function isGoodWord(wordRaw, hint, word_unit, type){
  if (!wordRaw) return false;
  if (wordRaw.includes("_") || wordRaw.includes("^") || wordRaw.includes("-")) return false;
  
  if (word_unit==="속담") {
    if (wordRaw.length<3 || wordRaw.length>15) return false;
    if (!hint) return false;
    return true;
  }
  
  const word = wordRaw.trim();
  if (word.length<2 || word.length>10) return false;
  if (["혼종어","외래어"].includes(type)) return false;
  return true;
}

// =====================
// Firebase에서 단어 존재 확인
// =====================
async function isWordExistsInDB(word) {
  try {
    console.log(`🔍 [중복체크] 단어 확인 중: "${word}"`);
    const snapshot = await POOL_REF.orderByChild('word').equalTo(word).once('value');
    const exists = snapshot.exists();
    console.log(`${exists ? '⚠️ [중복체크]' : '✓ [중복체크]'} 단어 "${word}" - 존재: ${exists}`);
    return exists;
  } catch (error) {
    console.error(`❌ [중복체크 오류] ${word}:`, error.message);
    throw error;
  }
}

// =====================
// Firebase 풀에 단어 추가
// =====================
async function addWordToPool(wordObj) {
  try {
    const key = `${wordObj.word}_${Date.now()}`;
    console.log(`📝 [DB저장] Firebase에 저장 시작: "${wordObj.word}" (Key: ${key})`);
    await POOL_REF.child(key).set(wordObj);
    console.log(`✅ [DB저장] Firebase 저장 완료: "${wordObj.word}"`);
    return key;
  } catch (error) {
    console.error(`❌ [DB저장 오류] ${wordObj.word}:`, error.message);
    throw error;
  }
}

// =====================
// Firebase에서 모든 퀴즈 데이터 가져오기
// =====================
async function getPoolFromDB() {
  try {
    console.log(`📥 [DB로드] Firebase에서 퀴즈 풀 로드 중...`);
    const snapshot = await POOL_REF.once('value');
    const data = snapshot.val();
    
    if (!data) {
      console.log(`⚠️ [DB로드] Firebase 퀴즈 풀이 비어있음`);
      return [];
    }
    
    const items = Object.values(data);
    console.log(`✅ [DB로드] Firebase에서 ${items.length}개 단어 로드 완료`);
    return items;
  } catch (error) {
    console.error(`❌ [DB로드 오류]:`, error.message);
    throw error;
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// =====================
// 검색 API
// =====================
app.get("/api/search", async (req, res) => {
  const word = req.query.word?.trim();
  console.log(`🔎 [검색] 요청: "${word}"`);
  
  if (!word) {
    console.log(`⚠️ [검색] 검색어 없음`);
    return res.json([]);
  }
  
  const resultsMap = new Map(); // 중복 단어 처리용
  
  return new Promise((resolve) => {
    yauzl.open(ZIP_PATH, {lazyEntries: true, decodeStrings: false}, (err, zipfile) => {
      if (err) {
        console.error(`❌ [검색 오류] ZIP 파일 열기 실패:`, err.message);
        return res.json([]);
      }
      
      zipfile.on("entry", entry => {
        if (!/\.json$/i.test(entry.fileName)) {
          return zipfile.readEntry();
        }
        
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) {
            console.error(`❌ [검색 오류] 스트림 열기 실패:`, err.message);
            return zipfile.readEntry();
          }
          
          let jsonBuffer = [];
          stream.on("data", chunk => jsonBuffer.push(chunk));
          stream.on("end", () => {
            try {
              const jsonStr = Buffer.concat(jsonBuffer).toString('utf8');
              const parsed = JSON.parse(jsonStr);
              const items = parsed?.channel?.item;
              
              if (Array.isArray(items)) {
                for (const raw of items) {
                  const wordRaw = raw?.word_info?.word;
                  if (!wordRaw) continue;
                  
                  const cleanWord = wordRaw.replace(/\(([^)]*)\)/g, (match, content) => {
                    if (content.length <= 2 && content.match(/^(을|를|이|가|와|과|은|는|도|만)$/)) {
                      return content;
                    }
                    return '';
                  }).trim();
                  
                  if (wordRaw.toLowerCase().includes(word.toLowerCase())) {
                    const hint = extractHint(raw.word_info?.pos_info, raw.word_info);
                    
                    if (hint && hint !== "정의 없음") {
                      // 같은 단어가 이미 있으면 힌트를 합침
                      if (resultsMap.has(cleanWord)) {
                        const existing = resultsMap.get(cleanWord);
                        // 기존 힌트와 새 힌트를 합침 (중복 제거)
                        const existingHints = existing.hint.split(" / ");
                        const newHints = hint.split(" / ");
                        
                        const allHints = [...new Set([...existingHints, ...newHints])];
                        existing.hint = allHints.map((h, i) => {
                          // 이미 번호가 있으면 제거하고 다시 번호 매김
                          const cleaned = h.replace(/^\d+\.\s*/, "");
                          return allHints.length > 1 ? `${i + 1}. ${cleaned}` : cleaned;
                        }).join(" / ");
                      } else {
                        resultsMap.set(cleanWord, {
                          word: cleanWord,
                          hint: hint
                        });
                      }
                    } else {
                      // 힌트가 없어도 단어는 추가
                      if (!resultsMap.has(cleanWord)) {
                        resultsMap.set(cleanWord, {
                          word: cleanWord,
                          hint: "정의 없음"
                        });
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.error(`❌ [검색 JSON파싱] ${entry.fileName}:`, e.message);
            }
            zipfile.readEntry();
          });
          stream.on("error", (err) => {
            console.error(`❌ [검색 스트림] 읽기 오류:`, err.message);
            zipfile.readEntry();
          });
        });
      });
      
      zipfile.on("end", () => {
        zipfile.close();
        const results = Array.from(resultsMap.values());
        console.log(`✅ [검색] 완료: ${results.length}개 단어 찾음`);
        res.json(results);
        resolve();
      });
      zipfile.on("error", (err) => {
        console.error(`❌ [검색 ZIP오류]:`, err.message);
        res.json([]);
        resolve();
      });
      zipfile.readEntry();
    });
  });
});
// =====================
// 퀴즈 배치 API
// =====================
app.get("/api/newbatch", async (req, res) => {
  try {
    console.log(`📡 [배치생성] 새 퀴즈 배치 요청`);
    
    const poolData = await getPoolFromDB();
    
    if (poolData.length === 0) {
      console.warn(`⚠️ [배치생성] 퀴즈 풀이 비어있음`);
      return res.json([]);
    }
    
    // Fisher-Yates 셔플
    const shuffled = [...poolData];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const result = shuffled.slice(0, 19);
    console.log(`✅ [배치생성] 완료: ${result.length}개 단어`);
    res.json(result);
  } catch (error) {
    console.error(`❌ [배치생성 오류]:`, error.message);
    res.json([]);
  }
});

// =====================
// DB 초기화 API
// =====================
app.get("/api/clear-pool", async (req, res) => {
  try {
    console.log(`🗑️ [DB초기화] Firebase 퀴즈 풀 전체 삭제 시작...`);
    await POOL_REF.remove();
    console.log(`✅ [DB초기화] 완료`);
    res.json({ success: true, message: "퀴즈 풀 전체 삭제 완료" });
  } catch (error) {
    console.error(`❌ [DB초기화 오류]:`, error.message);
    res.json({ success: false, message: `오류: ${error.message}` });
  }
});

// =====================
// 단어 추가 API
// =====================
app.get("/api/add-word", async (req, res) => {
  const { word, hint } = req.query;
  
  console.log(`➕ [단어추가] 요청 - 단어: "${word}", 뜻: "${hint}"`);
  
  if (!word || !hint) {
    console.log(`❌ [단어추가] 유효성 검사 실패 - 단어 또는 뜻 없음`);
    return res.json({ success: false, message: "단어와 뜻이 필요합니다." });
  }
  
  try {
    const cho = getChosung(word);
    if (!cho || cho.length === 0) {
      console.log(`❌ [단어추가] 초성 추출 실패: "${word}"`);
      return res.json({ success: false, message: "초성을 추출할 수 없습니다." });
    }
    
    console.log(`📝 [단어추가] 초성 추출됨: "${word}" → "${cho.join('')}"`);
    
    // Firebase에서 중복 확인
    const exists = await isWordExistsInDB(word);
    if (exists) {
      console.log(`⚠️ [단어추가] 중복 단어 - "${word}"`);
      return res.json({ success: false, message: "이미 추가된 단어입니다." });
    }
    
    const wordObj = {
      word: word,
      question: cho,
      hint: hint || "정의 없음",
      addedAt: new Date().toISOString()
    };
    
    // Firebase에 추가
    const key = await addWordToPool(wordObj);
    
    // 현재 풀 크기 가져오기
    const poolData = await getPoolFromDB();
    const totalCount = poolData.length;
    
    console.log(`✅ [단어추가] 성공 - 총 ${totalCount}개 단어`);
    res.json({ 
      success: true, 
      message: `${word} 추가됨 (총 ${totalCount}개)`,
      key: key
    });
  } catch (error) {
    console.error(`❌ [단어추가 오류]:`, error.message);
    res.json({ success: false, message: `오류 발생: ${error.message}` });
  }
});

// =====================
// ZIP 로딩 - 초성별 랜덤
// =====================
// =====================
// ZIP 로딩 - 초성별 랜덤 (완전 문제)
// =====================
function loadDictionary(limit = 7) {
  return new Promise((resolve, reject) => {
    const choGroups = new Map();  // ZIP 전체 전역 초성 Map

    yauzl.open(ZIP_PATH, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();

      zipfile.on("entry", (entry) => {
        if (!/\.json$/i.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (err, readStream) => {
          if (err || !readStream) {
            zipfile.readEntry();
            return;
          }

          let buffer = [];

          readStream.on("data", (chunk) => buffer.push(chunk));

          readStream.on("end", () => {
            try {
              const jsonStr = Buffer.concat(buffer).toString("utf8");
              const parsed = JSON.parse(jsonStr);
              const items = parsed?.channel?.item;

              if (Array.isArray(items)) {
                for (const raw of items) {
                  const wordRaw = raw?.word_info?.word;
                  if (!wordRaw) continue;
                  const cleanWord = wordRaw.replace(/\(([^)]*)\)/g, (match, content) => {
                    if (content.length <= 2 && content.match(/^(을|를|이|가|와|과|은|는|도|만)$/)) {
                      return content;
                    }
                    return '';
                  }).trim();

                  const unit = raw.word_info?.word_unit;
                  const type = raw.word_info?.word_type;
                  const hint = extractHint(raw.word_info?.pos_info, raw.word_info);

                  if (!isGoodWord(cleanWord, hint, unit, type)) continue;

                  const cho = getChosung(cleanWord);
                  if (!cho) continue;

                  const choKey = cho.join("");

                  if (!choGroups.has(choKey)) {
                    choGroups.set(choKey, []);
                  }

                  choGroups.get(choKey).push({
                    word: cleanWord,
                    question: cho,
                    hint: hint || "정의 없음",
                  });
                }
              }
            } catch (_) {
            } finally {
              zipfile.readEntry();
            }
          });

          readStream.on("error", () => {
            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => {
        // ------------------------
        //  ZIP 전체 초성 그룹에서 랜덤 추출
        // ------------------------
        const allChoKeys = Array.from(choGroups.keys());
        shuffleArray(allChoKeys);

        const result = [];

        for (const choKey of allChoKeys) {
          if (result.length >= limit) break;

          const group = choGroups.get(choKey);
          if (!group || group.length === 0) continue;

          const picked = group[Math.floor(Math.random() * group.length)];
          result.push(picked);
        }

        resolve(result);
      });

      zipfile.on("error", (err) => reject(err));
    });
  });
}


// =====================
// 서버 시작
// =====================
// =====================
// 서버 시작 (정상 버전)
// =====================

async function startServer() {
  console.log("초기화 시작");

  try {
    const existingPool = await getPoolFromDB();
    console.log(`기존 풀: ${existingPool.length}개`);

    const newData = await loadDictionary(7);
    console.log(`ZIP 로드: ${newData.length}개`);

    let savedCount = 0;
    const seenDuringStartup = new Set();

    for (const item of newData) {
      try {
        if (!item?.word) continue;

        const normalized = item.word.trim();

        if (seenDuringStartup.has(normalized)) continue;
        seenDuringStartup.add(normalized);

        const exists = await isWordExistsInDB(normalized);
        if (exists) continue;

        await addWordToPool(item);
        savedCount++;
        seenDuringStartup.add(normalized);
        console.log(`✅ [저장완료] "${normalized}" 저장됨`);
      } catch (error) {
        console.error("단어 추가 실패:", err);
      }
    }

    const finalPool = await getPoolFromDB();
    console.log(`최종 풀: ${finalPool.length}개`);

    // Vercel 환경에서는 listen 금지
    if (!process.env.VERCEL) {
      app.listen(PORT, () => {
        console.log(`서버 실행: http://localhost:${PORT}`);
      });
    } else {
      console.log("Vercel 환경: listen 생략, export only");
    }

  } catch (error) {
    console.error("초기화 오류:", error);

    if (!process.env.VERCEL) process.exit(1);
    throw error;
  }
}

// 실행
startServer().catch(err => {
  console.error("startServer 실패:", err);
});

// Vercel용 Export
export default app;
