// app.js - D휴가 앱 (문양승무팀 전용)
// 경산 휴가앱 최신 코드를 바탕으로 문양 전용으로 변환한 버전이에요. (경산 앱과는 완전히 별도 관리)
// 현재 단계: 로그인 흐름 (소속선택 → 이름선택 → 교번확인 → PIN설정 / 재로그인)
// TODO: fetchEmployees()의 실제 API 연동은 추후 처리 (지금은 더미 데이터)

const {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo
} = React;

/* ------------------------------------------------------------------ */
/* 실제 직원 데이터 연동 (교번앱 Apps Script, JSONP)                     */
/* + 기준일(baseDate) 대비 오늘까지의 날짜차이만큼 교번틀을 밀어서       */
/*   "오늘 기준 실제 교번"을 계산 (교번앱과 동일한 방식)                  */
/* ------------------------------------------------------------------ */
const GAS_URL = "https://script.google.com/macros/s/AKfycbw8NMVjH3J_Mt7SBymWOg44zvD4gd4GXkQB3r95QTl63M3aWqtf-OglLrG2rQPH7J6UjA/exec";

// (참고) 경산 휴가 데이터 - 교번앱이 이미 안정적으로 쓰고 있는 검증된 API (날짜가 완성된 형태로 옴)
const VACATION_API_URL = "https://script.google.com/macros/s/AKfycbxx07MyxgIYUHweQQYF_7ioGqekeVql3wdlTDt2fmYGEXKS0L4CRFzV50vZRdLVg0C5/exec";

// 가져오기 테스트에서 이 날짜 이전 기록은 제외 (필요하면 이 값만 바꾸면 돼요)
const IMPORT_FROM_DATE = "2026-07-01";

// 자동 백업 주기 - 마지막 백업 이후 이 시간이 지나면, 그다음 관리자/운용이 앱을 열 때 자동으로
// 백업돼요. 서버 스케줄러가 없어서 "정확히 며칠 몇 시"는 보장 못 하고, 그 이후 누군가 접속하는
// 시점에 실행돼요.
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1주일

// 밴드 채팅방 바로가기 (경산승무팀)
const BAND_URL = "https://band.us/band/51746678/chat/C4U1ay";
const TEAM_MAP = {
  my: "문양"
}; // 문양 전용 앱 (경산은 별도 앱으로 따로 관리)

// 경산에서만 쓰는 기능 스위치 - 문양에선 항상 false (켜지 마세요).
// 꺼지는 것: 짝수달 1일 오픈(오픈 안내·피크 실시간·본인 순번 수정), 취소 제한(짝수달 1~5일·7일 전),
//           3왕복 안내, 밴드 바로가기, 자동/수동 백업
// 문양에서도 켜져 있는 것: 순번(휴가 입력 순서대로 자동 부여·취소/삭제 시 빈 번호 정리),
//                        휴충당(신청순 정렬), 명절 연휴 추첨
const GS_ONLY = false;
// ⚠️ 테스트 모드: true면 누구나 교번확인/승인 없이 바로 들어갈 수 있고, "가져오기 테스트" 메뉴도 보여요.
// 문양 앱은 index.html의 window.APP_TEST_MODE 한 줄로 켜고 꺼요 (실사용 전환 시 거기만 false로).
// 저장소 구분용 APP_STORAGE_SUFFIX("_test")는 테스트 모드와 상관없이 그대로 둬요 - 바꾸면 기존 로그인이 풀려요.
const TEST_MODE = window.APP_TEST_MODE === true;

// ⚠️ 3단계 스위치: true면 휴가 데이터를 예전 구조(vacations) 대신 새 구조(vacation_days)로
// 읽고 써요. 보안규칙·색인·마이그레이션이 끝나서 이제 항상 true예요.
// 혹시 문제가 생기면 이 값을 false로 되돌리는 것만으로 예전 방식으로 즉시 복귀할 수 있어요
// (단, false로 되돌리면 그 사이 새 구조에 쌓인 신규 기록은 예전 화면엔 안 보이니 주의해주세요).
const USE_DAY_DOCS = true;
const REVERSE_TEAM_MAP = {
  문양: "my"
};

// 운용(중간관리자) 명단은 더 이상 코드에 하드코딩하지 않고 Firestore(window.ManagerAPI)로 관리해요.
// 관리자(권재림)가 앱 내 "운용 인원 관리" 화면에서 직접 추가/삭제할 수 있어요.
function isMidManagerUser(user, managers) {
  return (managers || []).some(m => m.name === user.name && m.branch === user.branch);
}
function jsonpRequest(url, params, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const callbackName = "jsonp_cb_" + Math.random().toString(36).slice(2);
    const query = new URLSearchParams({
      ...params,
      callback: callbackName
    }).toString();
    const script = document.createElement("script");
    script.src = url + "?" + query;
    let settled = false;
    const cleanup = () => {
      delete window[callbackName];
      script.remove();
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("응답이 늦어져서(타임아웃) 요청을 다시 시도해요"));
    }, timeoutMs);
    window[callbackName] = data => {
      if (settled) return; // 타임아웃으로 이미 포기한 뒤에 뒤늦게 응답이 와도 무시
      settled = true;
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("네트워크 오류로 직원 데이터를 불러오지 못했어요"));
    };
    document.body.appendChild(script);
  });
}

// fetch()는 원래 타임아웃이 없어서, 상대 서버가 응답을 안 주면 요청이 무한정 매달려있을 수 있어요.
// AbortController로 일정 시간이 지나면 강제로 포기하도록 감싸요 (백업 요청 등에 사용).
function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).catch(err => {
    if (err && err.name === "AbortError") {
      throw new Error("응답이 너무 오래 걸려서(타임아웃) 요청을 중단했어요. 잠시 후 다시 시도해주세요.");
    }
    throw err;
  }).finally(() => clearTimeout(timer));
}

// fetch뿐 아니라 Firestore 읽기 등 "어떤 단계든" 너무 오래 걸리면 강제로 포기시키는 범용 타임아웃.
// 네트워크가 불안정한 모바일 환경에서, 요청이 응답도 에러도 없이 그냥 무한정 매달려있는 상황을
// 막으려고 만들었어요 - fetchWithTimeout은 fetch 단계만 지켜주는데, 이건 그 앞뒤 어디든 걸 수 있어요.
function promiseWithTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || "요청"}이(가) 너무 오래 걸려서(타임아웃) 중단했어요. 잠시 후 다시 시도해주세요.`));
    }, timeoutMs);
    promise.then(v => {
      clearTimeout(timer);
      resolve(v);
    }, err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// 교번앱과 동일한 날짜 계산 방식 (한국 시간 기준)
function koreaTodayStr() {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utcTime + 9 * 60 * 60000);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 한국 시간 기준 현재 시(0~23) - 자동 백업을 새벽 시간대에 우선 실행하기 위한 용도
function koreaCurrentHour() {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utcTime + 9 * 60 * 60000);
  return kst.getHours();
}

// 오늘이 "짝수달 1일"인지 확인 (경산 - 다음 두 달 휴가를 선착순으로 신청받는 날, 순번 조정 가능일)
// ⚠️ TEST_MODE일 때는 실제 날짜와 무관하게 항상 "짝수달 1일"로 간주해서 순번 수정 기능을 바로 테스트할 수 있어요.
// 실제 운영 전환 시 TEST_MODE를 false로 바꾸면 이 우회도 자동으로 꺼져요.
function isEvenMonthFirstDay() {
  if (TEST_MODE) return true;
  const today = koreaTodayStr(); // "YYYY-MM-DD"
  const month = parseInt(today.slice(5, 7), 10);
  const day = parseInt(today.slice(8, 10), 10);
  return day === 1 && month % 2 === 0;
}

// 짝수달 1일 오전 9시~10시(오픈 직후 - 사람이 몰리고 신청/취소가 폭주하는 딱 그 시간대)인지 확인.
// 이 좁은 창 안에서만 실시간 구독을 잠깐 켜서, 평소엔 안전한 1회 조회 방식을 그대로 유지하면서도
// 정작 실시간 정확도가 제일 중요한 순간엔 자동 반영이 되도록 해요.
// ⚠️ TEST_MODE에서는 항상 true로 간주해서 언제든 테스트해볼 수 있어요.
function isPeakOpeningWindow() {
  if (TEST_MODE) return true;
  if (!isEvenMonthFirstDay()) return false;
  const hour = koreaCurrentHour();
  return hour === 9;
}
function parseLocalDate_(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function diffDays_(a, b) {
  const da = parseLocalDate_(a);
  const db = parseLocalDate_(b);
  da.setHours(0, 0, 0, 0);
  db.setHours(0, 0, 0, 0);
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}
function positiveMod_(n, mod) {
  if (!mod) return 0;
  return (n % mod + mod) % mod;
}

// 교번틀 순서(order) 안에서 baseCode 위치를 찾아 dayOffset만큼 민 코드 반환
function shiftCodeByDays_(order, baseCode, dayOffset) {
  if (!order || !order.length) return baseCode || "";
  const baseIdx = order.findIndex(c => String(c).trim() === String(baseCode).trim());
  if (baseIdx < 0) return baseCode || "";
  return order[positiveMod_(baseIdx + dayOffset, order.length)] || baseCode || "";
}
let GYOBUN_ORDER = {
  ks: [],
  my: []
}; // 달력 교번 계산용
let BASE_DATE = ""; // 달력 교번 계산용 (기준일)

/* ------------------------------------------------------------------ */
/* 교번 변경 예약 (시트는 그대로, 휴가앱 안에서만 날짜 기준으로 자리 교체)      */
/* - 항목: { id, groupId, branch, slotId, oldName, newName, date }       */
/*   "date 이전엔 slotId 자리 주인 = oldName, date부터는 newName"           */
/* - 예약이 있는 자리는 시트 이름과 상관없이 예약이 우선이라, 시트를 언제      */
/*   바꾸든(미리/당일/나중) 휴가앱 결과는 같아요.                            */
/* ------------------------------------------------------------------ */
let ROSTER_CHANGES = [];
let LAST_RAW_EMPLOYEES = []; // 시트에 실제로 적힌 그대로의 명단 (시트 반영 여부 확인용)
const LS_ROSTER_CHANGES = "roster_changes_cache";
function rosterChangesKey_() {
  return LS_ROSTER_CHANGES + (window.APP_STORAGE_SUFFIX || "");
}
function loadRosterChangesCache_() {
  try {
    const raw = JSON.parse(localStorage.getItem(rosterChangesKey_()) || "null");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function setRosterChanges_(items) {
  ROSTER_CHANGES = Array.isArray(items) ? items : [];
  try {
    localStorage.setItem(rosterChangesKey_(), JSON.stringify(ROSTER_CHANGES));
  } catch (_) {}
  window.dispatchEvent(new Event("roster-changes-updated"));
}
// 특정 자리(slotId)의 그 날짜 주인 이름 - 예약이 없으면 시트 이름 그대로
function slotOwnerOnDate_(slotId, branch, sheetName, dateStr) {
  const list = ROSTER_CHANGES.filter(c => c.slotId === slotId && c.branch === branch).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  if (!list.length) return sheetName;
  let owner = list[0].oldName;
  for (const c of list) {
    if (c.date <= dateStr) owner = c.newName;else break;
  }
  return owner;
}
// 그 날짜 기준으로 이름을 바꿔 끼운 명단 (id·baseCode·code는 자리 기준이라 그대로)
function employeesOnDate_(list, dateStr) {
  if (!ROSTER_CHANGES.length || !list || !list.length) return list || [];
  return list.map(e => {
    const owner = slotOwnerOnDate_(e.id, e.branch, e.name, dateStr);
    return owner === e.name ? e : {
      ...e,
      name: owner
    };
  });
}
// 그 날짜에 이 사람이 앉아 있는 자리의 기준교번 (예약 없으면 fallback 그대로)
function baseCodeForPersonOnDate_(list, name, branch, dateStr, fallback) {
  if (!ROSTER_CHANGES.some(c => c.branch === branch)) return fallback;
  const emp = employeesOnDate_(list, dateStr).find(e => e.name === name && e.branch === branch);
  return emp ? emp.baseCode : fallback;
}

const LS_EMPLOYEES_CACHE = "munyang_employees_cache" + (window.APP_STORAGE_SUFFIX || ""); // 경산 앱과 같은 주소(origin)라 저장소가 섞이지 않게 분리

// 직전에 성공적으로 받아온 직원/교번 데이터를 저장해둬요 - 다음에 앱을 켰을 때
// 네트워크 응답을 기다리지 않고 일단 이걸로 즉시 화면을 채우고, 최신 데이터는 뒤에서 조용히 갱신해요.
function saveEmployeesCache(list) {
  try {
    localStorage.setItem(LS_EMPLOYEES_CACHE, JSON.stringify({
      employees: list,
      gyobunOrder: GYOBUN_ORDER,
      baseDate: BASE_DATE,
      savedAt: Date.now()
    }));
  } catch (_) {}
}
function loadEmployeesCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_EMPLOYEES_CACHE) || "null");
    if (!raw || !Array.isArray(raw.employees) || !raw.employees.length) return null;
    return raw;
  } catch {
    return null;
  }
}

// 캐시에 저장된 기준일 기준 코드를, "오늘" 기준으로 다시 밀어서 계산해요.
// (캐시가 며칠 전에 저장된 거라도, baseCode+교번틀만 있으면 오늘자 코드를 정확히 다시 계산할 수 있어요)
function recomputeTodayCodesFromCache(cache) {
  const gyobunOrder = cache.gyobunOrder || {
    ks: [],
    my: []
  };
  const baseDate = cache.baseDate || "";
  const today = koreaTodayStr();
  const dayOffset = baseDate ? diffDays_(baseDate, today) : 0;
  return (cache.employees || []).map(e => {
    const teamKey = e.team || REVERSE_TEAM_MAP[e.branch];
    const order = gyobunOrder[teamKey] || [];
    return {
      ...e,
      code: shiftCodeByDays_(order, e.baseCode, dayOffset)
    };
  });
}
// 문양 명단에 없는 전체관리자(권재림 등)도 문양 앱에 로그인해서 관리할 수 있게 해줘요.
function isGuestAdminRow_(r) {
  return r.team !== "my" && SUPER_ADMIN_NAMES.includes(r.name) && ADMIN_NAMES.some(a => a.name === r.name && a.branch === "문양");
}
// 화면(MainScreen) 쪽에 넘길 명단 - 관리용 게스트는 빼요
function realEmployees_(list) {
  return (list || []).filter(e => !e.adminGuest);
}
function fetchEmployees() {
  return Promise.all([jsonpRequest(GAS_URL, {
    mode: "roster"
  }), jsonpRequest(GAS_URL, {
    mode: "gyobunOrder"
  })]).then(([rosterRes, orderRes]) => {
    if (!rosterRes || !rosterRes.ok) {
      throw new Error(rosterRes && rosterRes.error || "직원 데이터를 불러오지 못했어요");
    }
    if (!orderRes || !orderRes.ok) {
      throw new Error(orderRes && orderRes.error || "교번틀 데이터를 불러오지 못했어요");
    }
    GYOBUN_ORDER = {
      ks: orderRes.ks || [],
      my: orderRes.my || []
    };
    BASE_DATE = rosterRes.baseDate || orderRes.baseDate || "";
    const today = koreaTodayStr();
    const dayOffset = BASE_DATE ? diffDays_(BASE_DATE, today) : 0;
    // 문양 직원 + (관리용) 다른 소속 전체관리자 - 관리자는 로그인 때 본인 원래 교번으로 확인받고,
    // 화면 안에서는 문양 소속으로 동작해요. 휴가 명단·대신기록 대상자 등에는 안 나와요 (adminGuest).
    const list = rosterRes.rows.filter(r => r.team === "my" || isGuestAdminRow_(r)).map(r => {
      const order = orderRes[r.team] || [];
      const todayCode = shiftCodeByDays_(order, r.gyobun, dayOffset);
      const guest = r.team !== "my";
      return {
        id: r.employeeId || `${r.team}-${r.gyobun}-${r.name}`,
        name: r.name,
        branch: "문양",
        team: r.team,
        adminGuest: guest,
        code: todayCode,
        // 오늘 기준 실제 교번
        baseCode: r.gyobun // 기준일(4/1) 원본 (참고용)
      };
    });
    saveEmployeesCache(list);
    return list;
  });
}

// 네트워크 순간 오류 등으로 직원 데이터 로드가 실패하면, 조용히 포기하지 않고 몇 번 더 재시도해요.
function fetchEmployeesWithRetry(retries = 3, delayMs = 700) {
  return fetchEmployees().catch(err => {
    if (retries <= 0) throw err;
    console.warn(`직원 데이터 로드 실패, ${delayMs}ms 후 재시도 (남은 재시도: ${retries})`, err);
    return new Promise(resolve => setTimeout(resolve, delayMs)).then(() => fetchEmployeesWithRetry(retries - 1, delayMs));
  });
}

/* ------------------------------------------------------------------ */
/* 로컬 저장소 헬퍼 (PIN은 기기에만 저장)                                */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = "vacation_auth" + (window.APP_STORAGE_SUFFIX || "");
function saveLocalAuth(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function loadLocalAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 자주 안 바뀌는 목록(운용 명단 등) 캐싱 헬퍼 - 무료 읽기 한도 절약용         */
/* 경산/문양(테스트)은 APP_STORAGE_SUFFIX로 캐시 저장소가 자동 분리돼요.       */
/* ------------------------------------------------------------------ */
function loadCachedList(cacheKey, ttlMs, fetcher, forceRefresh) {
  const fullKey = cacheKey + (window.APP_STORAGE_SUFFIX || "");
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Date.now() - parsed.savedAt < ttlMs) {
          return Promise.resolve(parsed.data);
        }
      }
    } catch {
      // 캐시가 깨져 있으면 그냥 새로 불러와요
    }
  }
  return fetcher().then(data => {
    try {
      localStorage.setItem(fullKey, JSON.stringify({
        savedAt: Date.now(),
        data
      }));
    } catch {
      // 저장 공간이 꽉 찼거나 하면 캐싱만 실패 - 기능엔 지장 없음
    }
    return data;
  });
}
function invalidateCachedList(cacheKey) {
  const fullKey = cacheKey + (window.APP_STORAGE_SUFFIX || "");
  localStorage.removeItem(fullKey);
}
const MANAGER_CACHE_KEY = "vacation_managers_cache";
// 운용 명단은 로그인 권한 판단에도 쓰여서(새로 등록된 운용자가 바로 로그인해야 할 수 있음)
// 너무 길게 캐싱하면 안 돼요. 5분 정도면 짧은 시간 안에 여러 명이 몰려 접속할 때의
// 중복 읽기는 웬만큼 줄이면서, 신규 등록자가 오래 기다리는 일은 거의 없게 해줘요.
const MANAGER_CACHE_TTL_MS = 5 * 60 * 1000; // 5분

const LOTTERY_EVENTS_CACHE_KEY = "vacation_lottery_events_cache";
// 명절추첨 이벤트는 1년에 몇 번(설날/추석)만 생기고 그마저도 자주 안 바뀌어서,
// 운용 명단보다 훨씬 길게(30분) 캐싱해도 안전해요. 로그인할 때마다 매번 전체 이벤트
// 컬렉션을 읽는 대신, 하루 중 여러 번 접속해도 30분에 한 번만 실제로 읽으면 돼요.
const LOTTERY_EVENTS_CACHE_TTL_MS = 30 * 60 * 1000; // 30분

// 🆕 PIN을 그대로 서버에 저장하지 않고, "직원ID+PIN"을 변형(해시)한 값만 저장해요.
// 이러면 Firestore를 누가 열어봐도 진짜 PIN 자체는 알 수 없고, 같은 PIN이어도 사람마다
// 다른 값으로 저장돼요 (직원ID가 "소금" 역할). 로그인할 때도 이 변형값끼리만 비교해요.
async function hashPin(id, pin) {
  const enc = new TextEncoder();
  const data = enc.encode(`${id}:${pin}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* 공통 스타일                                                          */
/* ------------------------------------------------------------------ */
const styles = {
  screen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px"
  },
  title: {
    fontSize: "22px",
    fontWeight: 800,
    marginBottom: "24px",
    color: "#1b3a5c",
    textAlign: "center",
    letterSpacing: "-0.3px"
  },
  button: {
    width: "100%",
    maxWidth: "360px",
    padding: "16px",
    margin: "6px 0",
    borderRadius: "14px",
    border: "1px solid #e6e2d8",
    background: "#fff",
    fontSize: "16px",
    fontWeight: 600,
    color: "#1f2a33",
    cursor: "pointer"
  },
  primaryButton: {
    width: "100%",
    maxWidth: "360px",
    padding: "16px",
    margin: "16px 0 6px",
    borderRadius: "14px",
    border: "none",
    background: "#1b3a5c",
    fontSize: "16px",
    fontWeight: 700,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 10px rgba(27,58,92,0.25)"
  },
  pinDots: {
    display: "flex",
    gap: "24px",
    margin: "28px 0"
  },
  pinDot: filled => ({
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    background: filled ? "#d99a3d" : "#e6e2d8",
    boxShadow: filled ? "0 0 0 5px rgba(217,154,61,0.18)" : "none",
    transition: "box-shadow 120ms ease"
  }),
  keypad: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "30px",
    width: "100%",
    maxWidth: "420px"
  },
  key: {
    aspectRatio: "1",
    width: "100%",
    fontSize: "34px",
    fontWeight: 600,
    borderRadius: "50%",
    border: "none",
    background: "#fff",
    color: "#1f2a33",
    boxShadow: "0 2px 8px rgba(27,58,92,0.08)"
  },
  backspaceKey: {
    aspectRatio: "1",
    width: "100%",
    fontSize: "26px",
    borderRadius: "50%",
    border: "none",
    background: "transparent",
    color: "#b5aa96",
    boxShadow: "none"
  },
  errorText: {
    color: "#e02020",
    fontSize: "14px",
    marginTop: "8px"
  },
  subText: {
    color: "#888",
    fontSize: "14px",
    marginBottom: "16px",
    textAlign: "center"
  },
  select: {
    width: "100%",
    maxWidth: "360px",
    padding: "14px",
    margin: "6px 0",
    borderRadius: "12px",
    border: "1px solid #ddd",
    background: "#fff",
    fontSize: "16px",
    color: "#1a1a1a"
  },
  fieldLabel: {
    width: "100%",
    maxWidth: "360px",
    fontSize: "13px",
    color: "#666",
    margin: "12px 0 2px"
  }
};

/* ------------------------------------------------------------------ */
/* PIN 키패드 컴포넌트                                                   */
/* ------------------------------------------------------------------ */
function PinPad({
  length = 4,
  onComplete,
  error
}) {
  const [pin, setPin] = useState("");
  useEffect(() => {
    setPin("");
  }, [error]);
  const press = digit => {
    if (pin.length >= length) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === length) {
      onComplete(next);
      setTimeout(() => setPin(""), 300);
    }
  };
  const backspace = () => setPin(pin.slice(0, -1));

  // PC에서 마우스로 숫자 버튼을 누르는 것 외에, 키보드 숫자키(0~9)와 백스페이스로도 입력할 수 있게
  useEffect(() => {
    const handleKeyDown = e => {
      if (e.key >= "0" && e.key <= "9") {
        press(e.key);
      } else if (e.key === "Backspace") {
        backspace();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pin, length]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: styles.pinDots
  }, Array.from({
    length
  }).map((_, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: styles.pinDot(i < pin.length)
  }))), error && /*#__PURE__*/React.createElement("div", {
    style: styles.errorText
  }, error), /*#__PURE__*/React.createElement("div", {
    style: {
      ...styles.keypad,
      marginTop: "16px"
    }
  }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => /*#__PURE__*/React.createElement("button", {
    key: n,
    style: styles.key,
    onClick: () => press(String(n))
  }, n)), /*#__PURE__*/React.createElement("div", null), /*#__PURE__*/React.createElement("button", {
    style: styles.key,
    onClick: () => press("0")
  }, "0"), /*#__PURE__*/React.createElement("button", {
    style: styles.backspaceKey,
    onClick: backspace
  }, "⌫")));
}

/* ------------------------------------------------------------------ */
/* PWA 설치 배너 (안드로이드: 설치 버튼 / iOS: 안내 문구)                  */
/* ------------------------------------------------------------------ */
const installStyles = {
  bar: {
    width: "100%",
    maxWidth: "360px",
    background: "#eaf1ff",
    border: "1px solid #cfe0ff",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px"
  },
  text: {
    fontSize: "13px",
    color: "#333",
    flex: 1
  },
  installBtn: {
    flexShrink: 0,
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#1b3a5c",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 700
  },
  closeBtn: {
    flexShrink: 0,
    border: "none",
    background: "none",
    color: "#999",
    fontSize: "16px",
    padding: "0 4px"
  }
};
function InstallBanner({
  installPrompt,
  onInstall,
  showIosHint,
  dismissed,
  onDismiss
}) {
  if (dismissed) return null;
  if (installPrompt) {
    return /*#__PURE__*/React.createElement("div", {
      style: installStyles.bar
    }, /*#__PURE__*/React.createElement("span", {
      style: installStyles.text
    }, "📱 앱처럼 설치해서 쓸 수 있어요"), /*#__PURE__*/React.createElement("button", {
      style: installStyles.installBtn,
      onClick: onInstall
    }, "설치"), /*#__PURE__*/React.createElement("button", {
      style: installStyles.closeBtn,
      onClick: onDismiss
    }, "✕"));
  }
  if (showIosHint) {
    return /*#__PURE__*/React.createElement("div", {
      style: installStyles.bar
    }, /*#__PURE__*/React.createElement("span", {
      style: installStyles.text
    }, "📱 공유 버튼 → \"홈 화면에 추가\"로 앱처럼 설치할 수 있어요"), /*#__PURE__*/React.createElement("button", {
      style: installStyles.closeBtn,
      onClick: onDismiss
    }, "✕"));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 에러 경계 - 특정 화면(주로 실험적인 관리자 도구)에서 예상 못한 오류가 나도  */
/* 앱 전체가 하얗게 죽지 않고, 그 화면만 에러 안내로 대체되도록 막아줘요.     */
/* ------------------------------------------------------------------ */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }
  componentDidCatch(error, info) {
    console.error("ErrorBoundary가 잡은 오류:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return /*#__PURE__*/React.createElement("div", {
        style: modal.overlay,
        onClick: this.props.onClose
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          ...modal.sheet,
          maxWidth: "340px"
        },
        onClick: e => e.stopPropagation()
      }, /*#__PURE__*/React.createElement("div", {
        style: modal.dateTitle
      }, "⚠️ 오류가 발생했어요"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "#e02020",
          whiteSpace: "pre-wrap",
          marginBottom: "14px"
        }
      }, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)), /*#__PURE__*/React.createElement("button", {
        style: modal.closeBtn,
        onClick: this.props.onClose
      }, this.props.closeLabel || "닫기")));
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* 메인 앱                                                              */
/* ------------------------------------------------------------------ */
function App() {
  // step: "loading" | "chooseBranch" | "nameAndCode" | "setPin" | "loginName" | "loginPin" | "main"
  const [step, setStep] = useState("loading");
  const [rawEmployees, setEmployees] = useState([]); // 시트 그대로
  const [rosterVersion, setRosterVersion] = useState(0); // 교번 변경 예약이 바뀌면 +1 → 명단 다시 계산
  // 화면 전체에서 쓰는 명단은 "오늘 기준"으로 교번 변경 예약을 반영한 것
  const employees = useMemo(() => {
    LAST_RAW_EMPLOYEES = rawEmployees;
    return employeesOnDate_(rawEmployees, koreaTodayStr());
  }, [rawEmployees, rosterVersion]);
  useEffect(() => {
    const onChanged = () => setRosterVersion(v => v + 1);
    window.addEventListener("roster-changes-updated", onChanged);
    // 캐시로 먼저 적용하고, 서버 최신본은 뒤에서 받아와요 (문서 1개 읽기)
    const cached = loadRosterChangesCache_();
    if (cached.length) setRosterChanges_(cached);
    waitForFirestore().then(() => {
      if (window.SystemAPI && window.SystemAPI.getRosterChanges) {
        return window.SystemAPI.getRosterChanges().then(items => setRosterChanges_(items));
      }
    }).catch(err => console.error("교번 변경 예약 불러오기 실패:", err));
    return () => window.removeEventListener("roster-changes-updated", onChanged);
  }, []);
  const [managers, setManagers] = useState([]); // 운용(중간관리자) 명단 - Firestore
  const [localAuth, setLocalAuth] = useState([]);
  const [branch, setBranch] = useState(null);
  const [role, setRole] = useState(null); // "기관사" | "운용"
  const [addManagerOnly, setAddManagerOnly] = useState(false); // "이 기기에 다른 사람 등록"은 운용 전용
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [pendingNameId, setPendingNameId] = useState("");
  const [pendingCode, setPendingCode] = useState("");
  const [loginTarget, setLoginTarget] = useState(null);
  const [pinError, setPinError] = useState("");
  const [firstPin, setFirstPin] = useState(""); // PIN 최초 설정 시 재입력 확인용

  // PWA 설치 배너 관련
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(localStorage.getItem("install_banner_dismissed") === "1");
  useEffect(() => {
    const handler = e => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    if (isIos && !isStandalone) setShowIosHint(true);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const handleInstallClick = () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.finally(() => setInstallPrompt(null));
  };
  const handleDismissBanner = () => {
    setBannerDismissed(true);
    localStorage.setItem("install_banner_dismissed", "1");
  };
  const installBanner = /*#__PURE__*/React.createElement(InstallBanner, {
    installPrompt: installPrompt,
    onInstall: handleInstallClick,
    showIosHint: showIosHint,
    dismissed: bannerDismissed,
    onDismiss: handleDismissBanner
  });
  useEffect(() => {
    const auth = loadLocalAuth();
    setLocalAuth(auth);

    // 재로그인(이미 등록된) 사용자는 직원 데이터를 기다릴 필요 없이 바로 진입
    if (auth.length > 0) {
      setStep("loginName");
    }

    // 캐시가 있으면 네트워크 응답을 기다리지 않고 일단 이걸로 즉시 채워요 (오늘 날짜 기준으로 다시 계산).
    // 최신 데이터는 바로 아래에서 어차피 새로 받아와서 덮어써요 - 이건 그 사이의 "대기시간"만 없애는 용도예요.
    const cache = loadEmployeesCache();
    if (cache) {
      GYOBUN_ORDER = cache.gyobunOrder || {
        ks: [],
        my: []
      };
      BASE_DATE = cache.baseDate || "";
      setEmployees(recomputeTodayCodesFromCache(cache));
    }

    // 직원 데이터는 신규 등록 시 필요하고, 재로그인 사용자도 달력의 날짜별 교번 표시에 필요해서
    // 어차피 백그라운드로 가져옴. 실패하면 조용히 포기하지 않고 자동으로 재시도해요.
    fetchEmployeesWithRetry().then(list => {
      setEmployees(list);
      if (auth.length === 0) setStep("chooseBranch");
    }).catch(err => {
      console.error(err);
      if (auth.length === 0) {
        alert("직원 데이터를 불러오지 못했어요: " + (err && err.message ? err.message : err));
        setStep("chooseBranch");
      }
      // 재로그인 사용자는 이미 화면이 떠 있어요. 빠른 재시도(fetchEmployeesWithRetry)까지 다
      // 실패했어도 완전히 포기하지 않고, 좀 더 여유 있는 간격으로 배경에서 계속 시도해요
      // (네트워크가 잠깐 불안정해도 결국엔 알아서 채워지도록 - "···"에 영영 갇히는 것 방지).
      const keepTryingInBackground = attemptsLeft => {
        if (attemptsLeft <= 0) return;
        setTimeout(() => {
          fetchEmployees().then(list => setEmployees(list)).catch(() => keepTryingInBackground(attemptsLeft - 1));
        }, 8000);
      };
      keepTryingInBackground(15); // 8초 간격으로 최대 15번 더 (약 2분)
    });

    // 운용(중간관리자) 명단은 Firestore에서 불러옴 (1시간 캐싱 - 자주 안 바뀌니 매번 새로 읽지 않아요)
    waitForFirestore().then(() => loadCachedList(MANAGER_CACHE_KEY, MANAGER_CACHE_TTL_MS, () => window.ManagerAPI.list())).then(list => setManagers(list)).catch(err => console.error("운용 명단 로드 실패:", err));

    // 보관 기한(1년) 지난 오래된 휴가 기록 자동 삭제 - 예: 2027년이 되면 2025년 데이터부터 삭제
    // (연 1회만 실제로 지우도록, 이 기기에서 올해 이미 정리했는지 localStorage로 확인)
    const CLEANUP_KEY = "vacation_cleanup_year" + (window.APP_STORAGE_SUFFIX || "");
    const currentYear = new Date().getFullYear();
    const lastCleanupYear = parseInt(localStorage.getItem(CLEANUP_KEY) || "0", 10);
    if (lastCleanupYear < currentYear) {
      waitForFirestore().then(() => Promise.all([VacFacade.deleteOlderThan(`${currentYear - 1}-01-01`), window.HyuchungdangAPI.deleteOlderThan(`${currentYear - 1}-01-01`)])).then(() => localStorage.setItem(CLEANUP_KEY, String(currentYear))).catch(err => console.error("오래된 기록 정리 실패:", err));
    }
  }, []);
  const branchEmployees = employees.filter(e => e.branch === branch && !localAuth.some(a => a.id === e.id));

  // 운용(중간관리자) 명단 - 교번 없음
  const branchManagerEntries = managers.filter(m => m.branch === branch).map(m => ({
    id: m.id,
    name: m.name,
    branch: m.branch,
    code: null
  })).filter(m => !localAuth.some(a => a.id === m.id));

  // 선택한 구분(기관사/운용)에 따라 이름 목록을 분리해서 보여줌
  const nameOptions = role === "운용" ? branchManagerEntries : branchEmployees;
  const selectedNameEntry = nameOptions.find(e => e.id === pendingNameId);
  const selectedIsManager = !!selectedNameEntry && selectedNameEntry.code === null;

  /* ---- 최초 설정 흐름 ---- */
  const handleChooseBranch = b => {
    setBranch(b);
    setRole(null);
    setAddManagerOnly(false);
    setPendingNameId("");
    setPendingCode("");
    setStep("chooseRole");
  };

  // "이 기기에 다른 사람 등록" 전용 - 운용만 추가할 수 있어서 구분 선택 단계를 건너뜀
  const handleChooseBranchManagerOnly = b => {
    setBranch(b);
    setRole("운용");
    setPendingNameId("");
    setPendingCode("");
    setStep("nameAndCode");
  };
  const handleChooseRole = r => {
    setRole(r);
    setPendingNameId("");
    setPendingCode("");
    setStep("nameAndCode");
  };
  const branchOrder = GYOBUN_ORDER[REVERSE_TEAM_MAP[branch]] || [];
  const templateCodes = branchOrder.filter(c => branchEmployees.some(e => e.code === c));
  // 교번틀에 없는 코드(갑/을/병/현업일근 등 중간관리자 근무형태)도 뒤에 붙여서 보여줌
  const otherCodes = [...new Set(branchEmployees.map(e => e.code))].filter(c => !templateCodes.includes(c));
  const branchCodes = [...templateCodes, ...otherCodes];
  const handleConfirmNameCode = () => {
    const emp = nameOptions.find(e => e.id === pendingNameId);
    if (!emp) {
      alert("이름을 선택해주세요");
      return;
    }

    // 관리직(교번 없음)은 교번 확인 단계 없이 바로 진행
    // ※ 교번 검증은 테스트 버전이어도 절차상 그대로 유지해요 (TEST_MODE와 무관)
    if (emp.code !== null) {
      if (!pendingCode) {
        alert("교번을 선택해주세요");
        return;
      }
      if (pendingCode !== emp.code) {
        alert("교번이 일치하지 않아요. 본인의 오늘자 현재 교번을 다시 확인해주세요.");
        return;
      }
    }

    // TEST_MODE에서는 "이미 승인된 기기" 같은 중복 차단만 건너뛰고, 그 외 절차(교번확인·PIN)는 그대로 거쳐요
    if (TEST_MODE || isAdminUser(emp) || isMidManagerUser(emp, managers)) {
      setSelectedEmp(emp);
      setStep("setPin");
      return;
    }
    waitForFirestore().then(() => window.ApprovalAPI.getStatus(emp.id)).then(data => {
      if (data && data.status === "approved") {
        // 🆕 무조건 막지 않고, 이 계정 PIN을 알고 있으면 이 자리에서 바로 로그인할 수 있게 해요.
        setSelectedEmp(emp);
        setPinError("");
        setStep("crossBrowserPin");
        return;
      }
      if (data && data.status === "pending") {
        alert("이미 대기중인 신청 건이 있어요. 관리자 확인 후 처리될 때까지 기다려주세요.\n(본인이 신청한 게 아니라면 관리자에게 바로 알려주세요!)");
        return;
      }
      setSelectedEmp(emp);
      setStep("setPin");
    }).catch(err => {
      console.error(err);
      alert("확인 중 오류가 발생했어요: " + (err && err.message ? err.message : err));
    });
  };

  // PIN 최초 입력 → 재확인 단계로 이동
  const handlePinFirstEntry = pin => {
    setFirstPin(pin);
    setStep("setPinConfirm");
  };

  // PIN 재입력 확인 → 일치하면 실제 등록 진행, 불일치하면 처음부터 다시
  const handlePinConfirm = pin => {
    if (pin !== firstPin) {
      alert("PIN이 일치하지 않아요. 처음부터 다시 입력해주세요.");
      setFirstPin("");
      setStep("setPin");
      return;
    }
    handleSetPin(pin);
  };
  const handleSetPin = pin => {
    const updated = [...localAuth, {
      id: selectedEmp.id,
      name: selectedEmp.name,
      branch: selectedEmp.branch,
      pin
    }];
    saveLocalAuth(updated);
    setLocalAuth(updated);

    // 🆕 PIN 해시를 서버에도 저장해둬요 - 나중에 다른 브라우저에서 로그인할 때 대조용으로 써요.
    // 실패해도(오프라인 등) 등록 자체는 계속 진행시켜요 (로컬 저장은 이미 됐으니까).
    hashPin(selectedEmp.id, pin).then(pinHash => waitForFirestore().then(() => window.AuthAPI.setPinHash(selectedEmp.id, pinHash))).catch(err => console.error("PIN 해시 저장 실패:", err));
    if (TEST_MODE || isAdminUser(selectedEmp) || isMidManagerUser(selectedEmp, managers)) {
      // 관리자는 승인 절차 없이 바로 진입 (본인이 승인권자니까)
      setStep("main");
      return;
    }
    waitForFirestore().then(() => window.ApprovalAPI.request({
      id: selectedEmp.id,
      name: selectedEmp.name,
      branch: selectedEmp.branch
    })).then(() => setStep("pendingApproval")).catch(err => {
      console.error(err);
      alert("승인 요청 중 오류가 발생했어요: " + (err && err.message ? err.message : err));
      setStep("pendingApproval");
    });
  };

  /* ---- 재로그인 흐름 ---- */
  const handleLoginNameSelect = auth => {
    setLoginTarget(auth);
    setStep("loginPin");
    setPinError("");
  };
  const handleLoginPin = pin => {
    if (loginTarget.pin !== pin) {
      setPinError("PIN이 일치하지 않아요");
      return;
    }

    // 🆕 예전(이 기능 생기기 전)에 등록한 사람은 서버에 PIN 해시가 없을 수 있어요.
    // 정상적으로 로그인에 성공한 이 순간, 조용히 백그라운드로 해시를 채워둬서
    // 이 사람도 다음부터는 다른 브라우저에서 로그인할 수 있게 해요.
    hashPin(loginTarget.id, pin).then(pinHash => waitForFirestore().then(() => window.AuthAPI.setPinHash(loginTarget.id, pinHash))).catch(err => console.error("PIN 해시 백필 실패:", err));
    if (TEST_MODE || isAdminUser(loginTarget) || isMidManagerUser(loginTarget, managers)) {
      setStep("main");
      return;
    }
    waitForFirestore().then(() => window.ApprovalAPI.getStatus(loginTarget.id)).then(data => {
      // 명단(직원목록)에 아직 이 사람 이름이 있는지 확인 - ID가 아니라 이름 기준이에요.
      // (자리 바꿀 때 ID는 고정, 이름을 서로 바꾸는 방식으로 운영하고 계셔서, 그 사람이
      // "진짜로 없어졌는지"는 이름으로 찾아야 정확해요)
      const stillInRoster = (employees || []).some(e => e.name === loginTarget.name && e.branch === loginTarget.branch);
      if (!data) {
        // 승인 기록이 없어졌어요 - 관리자가 "기록삭제"를 눌렀거나, 예전 TEST_MODE 가입자예요.
        if (!stillInRoster) {
          setStep("notInRoster");
          return null;
        }
        return window.ApprovalAPI.request({
          id: loginTarget.id,
          name: loginTarget.name,
          branch: loginTarget.branch
        }).then(() => setStep("pendingApproval"));
      }
      if (data.status === "pending") {
        setStep("pendingApproval");
      } else if (data.status === "rejected") {
        setStep("rejected");
      } else if (!stillInRoster) {
        // 🆕 승인 기록은 그대로 있지만(관리자가 "기록삭제"를 안 눌렀어도), 정상 로그인할
        // 때마다 명단에 아직 있는지 슬쩍 확인해요 - 인사이동으로 명단에서만 빠진 경우를 잡아내요.
        setStep("notInRoster");
      } else {
        setStep("main");
      }
    }).catch(err => {
      console.error(err);
      alert("승인 상태 확인 중 오류가 발생했어요: " + (err && err.message ? err.message : err));
    });
  };

  // 🆕 다른 브라우저(새 기기 취급되는 상황)에서 이미 승인된 계정으로 로그인 - 서버에 저장된
  // PIN 해시랑 대조해서 확인해요. 성공하면 이 브라우저에도 로컬로 저장해서 다음부턴 빠르게 써요.
  const handleCrossBrowserPin = pin => {
    hashPin(selectedEmp.id, pin).then(pinHash => waitForFirestore().then(() => Promise.all([window.AuthAPI.getPinHash(selectedEmp.id), window.ApprovalAPI.getStatus(selectedEmp.id)])).then(([storedHash, approvalData]) => {
      if (!approvalData || approvalData.status !== "approved") {
        setPinError("이 계정은 지금 승인된 상태가 아니에요. 관리자에게 문의해주세요.");
        return;
      }
      if (!storedHash) {
        setPinError("이 계정은 아직 이 방법으로 로그인할 수 없어요. 원래 쓰던 기기에서 한 번 로그인해주시면 다음부터 가능해져요.");
        return;
      }
      if (storedHash !== pinHash) {
        setPinError("PIN이 일치하지 않아요");
        return;
      }
      // 🆕 여기서도 명단에 아직 있는지 확인해요 (이름 기준)
      const stillInRoster = (employees || []).some(e => e.name === selectedEmp.name && e.branch === selectedEmp.branch);
      if (!stillInRoster) {
        setStep("notInRoster");
        return;
      }
      const updated = [...localAuth, {
        id: selectedEmp.id,
        name: selectedEmp.name,
        branch: selectedEmp.branch,
        pin
      }];
      saveLocalAuth(updated);
      setLocalAuth(updated);
      setPinError("");
      setStep("main");
    })).catch(err => {
      console.error(err);
      setPinError("확인 중 오류가 발생했어요");
    });
  };
  const handleResetAll = () => {
    if (!confirm("이 기기에 저장된 로그인 정보를 전부 지울까요?\n(테스트용 초기화 - 다시 처음부터 등록해야 해요)")) return;
    localStorage.removeItem(STORAGE_KEY);
    setLocalAuth([]);
    setStep("chooseBranch");
  };

  // PIN을 잊었을 때 - 이 기기에 저장된 "본인 것만" 지우고 처음부터 다시 등록하게 해요.
  // (다른 사람이 같은 기기에 같이 등록되어 있어도 그 사람 건 안 건드려요)
  const handleForgotPin = () => {
    if (!loginTarget) return;
    if (!confirm(`${loginTarget.name}님의 이 기기 등록 정보를 지우고 처음부터 다시 등록할까요?\n(다시 등록하면 관리자 승인을 다시 받아야 해요)`)) return;
    const updated = localAuth.filter(a => a.id !== loginTarget.id);
    saveLocalAuth(updated);
    setLocalAuth(updated);
    setLoginTarget(null);
    setPinError("");
    setStep("chooseBranch");
  };

  // 공용 PC 등, 이 기기에 운용 인원을 추가로 등록할 때 사용 (기존 등록자는 유지됨, 기관사는 등록 불가)
  const handleAddAnother = () => {
    setBranch(null);
    setRole(null);
    setAddManagerOnly(true);
    setPendingNameId("");
    setPendingCode("");
    setStep("chooseBranch");
  };

  /* ------------------------------ 화면 렌더링 ------------------------------ */

  if (step === "loading") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, "불러오는 중...");
  }

  // 소속 선택
  if (step === "chooseBranch") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, installBanner, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, addManagerOnly ? "운용 인원 추가 · 소속을 선택해주세요" : "소속을 선택해주세요"), addManagerOnly ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      style: styles.button,
      onClick: () => handleChooseBranchManagerOnly("문양")
    }, "문양승무팀")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      style: styles.button,
      onClick: () => handleChooseBranch("문양")
    }, "문양승무팀")), addManagerOnly && /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => {
        setAddManagerOnly(false);
        setStep("loginName");
      }
    }, "← 취소"));
  }

  // 구분 선택 (기관사 / 운용)
  if (step === "chooseRole") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, installBanner, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, branch, " · 구분을 선택해주세요"), /*#__PURE__*/React.createElement("button", {
      style: styles.button,
      onClick: () => handleChooseRole("기관사")
    }, "기관사"), /*#__PURE__*/React.createElement("button", {
      style: styles.button,
      onClick: () => handleChooseRole("운용")
    }, "운용"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => setStep("chooseBranch")
    }, "← 소속 다시 선택"));
  }

  // 이름 + 교번 확인 (한 페이지, 드롭다운)
  if (step === "nameAndCode") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, installBanner, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, branch, " · ", role, " · 이름을 선택해주세요"), nameOptions.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, role === "운용" ? "등록된 운용 인원이 없어요. 관리자에게 문의해주세요." : "표시할 이름이 없어요. 인사이동으로 새로 오신 경우 직원목록 시트 반영 후 다시 시도해주세요."), nameOptions.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: styles.fieldLabel
    }, "이름"), /*#__PURE__*/React.createElement("select", {
      style: styles.select,
      value: pendingNameId,
      onChange: e => {
        setPendingNameId(e.target.value);
        setPendingCode("");
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "이름 선택"), [...nameOptions].sort((a, b) => a.name.localeCompare(b.name, "ko")).map(emp => /*#__PURE__*/React.createElement("option", {
      key: emp.id,
      value: emp.id
    }, emp.name))), selectedNameEntry && selectedIsManager && /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "관리직은 교번 확인 없이 등록돼요"), selectedNameEntry && !selectedIsManager && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: styles.fieldLabel
    }, "본인의 현재 교번"), /*#__PURE__*/React.createElement("select", {
      style: styles.select,
      value: pendingCode,
      onChange: e => setPendingCode(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번 선택"), branchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, c)))), /*#__PURE__*/React.createElement("button", {
      style: styles.primaryButton,
      onClick: handleConfirmNameCode
    }, "확인")), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => setStep(addManagerOnly ? "chooseBranch" : "chooseRole")
    }, addManagerOnly ? "← 소속 다시 선택" : "← 구분 다시 선택"));
  }

  // PIN 설정 (1차 입력)
  if (step === "setPin") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "사용하실 PIN 4자리를 설정해주세요"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "이 PIN은 이 휴대폰에만 저장돼요"), /*#__PURE__*/React.createElement(PinPad, {
      onComplete: handlePinFirstEntry
    }));
  }

  // PIN 설정 (재입력 확인)
  if (step === "setPinConfirm") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "PIN을 한 번 더 입력해주세요"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "정확히 입력했는지 확인할게요"), /*#__PURE__*/React.createElement(PinPad, {
      onComplete: handlePinConfirm
    }));
  }

  // 재로그인 - 이름 선택
  if (step === "loginName") {
    const hasManagerOnDevice = localAuth.some(a => isMidManagerUser(a, managers));
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, installBanner, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "이름을 선택해주세요"), localAuth.map(a => /*#__PURE__*/React.createElement("button", {
      key: a.id,
      style: styles.button,
      onClick: () => handleLoginNameSelect(a)
    }, a.name, " (", a.branch, ")")), hasManagerOnDevice && /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "1px dashed #1b3a5c",
        color: "#1b3a5c",
        marginTop: "16px"
      },
      onClick: handleAddAnother
    }, "+ 이 기기에 다른 사람 등록"), TEST_MODE && /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#e02020",
        marginTop: "8px"
      },
      onClick: handleResetAll
    }, "🔄 (테스트용) 전체 초기화"));
  }

  // 승인 대기중
  if (step === "pendingApproval") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "승인 대기중이에요 ⏳"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "관리자가 확인 후 승인하면 사용하실 수 있어요"), /*#__PURE__*/React.createElement("button", {
      style: styles.primaryButton,
      onClick: () => {
        const target = loginTarget || selectedEmp;
        const id = target === null || target === void 0 ? void 0 : target.id;
        if (!id) return;
        window.ApprovalAPI.getStatus(id).then(data => {
          if (data && data.status === "approved") {
            setStep("main");
          } else if (data && data.status === "rejected") {
            setStep("rejected");
          } else if (!data) {
            // 승인 기록이 아예 없으면(TEST_MODE 시절 가입 등) 여기서 자동으로 신청 생성
            window.ApprovalAPI.request({
              id: target.id,
              name: target.name,
              branch: target.branch
            }).then(() => alert("신청을 새로 등록했어요. 관리자 확인을 기다려주세요.")).catch(err => alert("신청 등록 실패: " + (err && err.message ? err.message : err)));
          } else {
            alert("아직 승인 대기중이에요");
          }
        });
      }
    }, "승인 상태 다시 확인"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => setStep("loginName")
    }, "나가기"));
  }

  // 승인 거절됨
  if (step === "rejected") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "승인이 거절됐어요"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "본인이 맞다면 관리자에게 직접 문의해주세요"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => setStep("loginName")
    }, "나가기"));
  }
  // 🆕 승인 기록이 없어졌고, 직원명단(스프레드시트)에서도 이름이 사라진 경우 - 인사이동/퇴사로 추정돼요.
  if (step === "notInRoster") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, "현재 직원명단에서 확인되지 않아요"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "인사이동·퇴사 등의 사유로 명단에서 빠진 것으로 보여요.", /*#__PURE__*/React.createElement("br", null), "문의사항은 관리자에게 연락해주세요."), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888"
      },
      onClick: () => setStep("loginName")
    }, "나가기"));
  }
  if (step === "loginPin") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, loginTarget.name, "님, PIN을 입력해주세요"), /*#__PURE__*/React.createElement(PinPad, {
      onComplete: handleLoginPin,
      error: pinError
    }), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888",
        marginTop: "20px"
      },
      onClick: handleForgotPin
    }, "PIN을 잊으셨나요? 다시 등록하기"));
  }

  // 🆕 다른 브라우저(새 기기 취급)에서, 이미 승인된 계정이면 PIN만 확인하고 바로 로그인
  if (step === "crossBrowserPin") {
    return /*#__PURE__*/React.createElement("div", {
      style: styles.screen
    }, /*#__PURE__*/React.createElement("div", {
      style: styles.title
    }, selectedEmp === null || selectedEmp === void 0 ? void 0 : selectedEmp.name, "님, 이미 승인된 계정이에요"), /*#__PURE__*/React.createElement("div", {
      style: styles.subText
    }, "원래 쓰시던 PIN을 입력하면 이 브라우저에서도 바로 로그인돼요"), /*#__PURE__*/React.createElement(PinPad, {
      onComplete: handleCrossBrowserPin,
      error: pinError
    }), /*#__PURE__*/React.createElement("button", {
      style: {
        ...styles.button,
        border: "none",
        color: "#888",
        marginTop: "20px"
      },
      onClick: () => {
        setPinError("");
        setStep("chooseBranch");
      }
    }, "취소하고 처음으로"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...styles.subText,
        marginTop: "16px",
        fontSize: "13px"
      }
    }, "PIN이 기억 안 나시면, 관리자에게 '기록삭제'를 요청해주세요."));
  }

  // 메인 화면 - 날짜별 조회
  if (step === "main") {
    return /*#__PURE__*/React.createElement(MainScreen, {
      currentUser: loginTarget || {
        ...selectedEmp
      },
      employees: realEmployees_(employees),
      managers: managers,
      onSwitchUser: () => setStep("loginName")
    });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Firestore 준비 대기 헬퍼                                             */
/* ------------------------------------------------------------------ */
function waitForFirestore() {
  return new Promise(resolve => {
    if (window.__firestoreReady) return resolve();
    window.addEventListener("firestore-ready", () => resolve(), {
      once: true
    });
  });
}
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function weekdayShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return WEEKDAYS[d.getDay()];
}
function formatDateHeader(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${dateStr} ${WEEKDAYS[d.getDay()]}요일`;
}

// Firestore Timestamp 객체든, 캐시/저장을 거치면서 일반 객체({seconds, nanoseconds})로 바뀐 것이든,
// 문자열/Date든 상관없이 안전하게 밀리초 값으로 변환해요. 하나라도 형태가 안 맞으면 못 구해서
// 정렬이 꼬이는 걸 방지하려고, formatEntryTime 표시 로직이랑 정렬 로직이 똑같이 이 함수를 써요.
function timestampToMillis_(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") {
    const d = ts.toDate();
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  if (typeof ts === "object" && typeof ts.seconds === "number") {
    return ts.seconds * 1000 + (typeof ts.nanoseconds === "number" ? ts.nanoseconds / 1e6 : 0);
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// dateOnly가 true면(가져오기로 들어와 실제 신청 "시각" 정보가 없는 기록) 시간 없이 날짜만 표시해요.
function formatEntryTime(ts, dateOnly) {
  const millis = timestampToMillis_(ts);
  if (millis == null) return "";
  const date = new Date(millis);
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  if (dateOnly) {
    return `${date.getMonth() + 1}/${date.getDate()} 입력`;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${mo}/${dd} ${hh}:${mm} 입력`;
}

// createdAt(Firestore Timestamp)에서 "YYYY-MM-DD"만 추출 (순번 수정 가능 여부 판단용 - "그날 신청한 기록"인지 확인)
function formatEntryDateOnly(ts) {
  if (!ts) return "";
  const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}

// 경산 팀 자체 규정 - 짝수달 1~5일 사이 신청한 휴가, 휴가일 7일 전부터는 본인 취소 불가 (여러 화면에서 공용으로 사용)
// 단, 짝수달 1일에 신청한 휴가는 1일 당일에 한해 취소 가능
function checkSelfCancelAllowed(branch, record) {
  if (!GS_ONLY) return {
    ok: true
  };
  if (record.createdAt) {
    const createdDateStr = formatEntryDateOnly(record.createdAt);
    if (createdDateStr) {
      const d = new Date(createdDateStr + "T00:00:00");
      const day = d.getDate();
      const month = d.getMonth() + 1;
      // 예외: 짝수달 1일 당일에 신청한 휴가는 그날 하루만 취소 가능 (순번이 안 되는데 먼저 신청해버린 경우
      // 원래 순번인 사람에게 자리를 돌려줄 수 있게) - 순번 조정이 1일에만 되는 것과 같은 기준이에요
      if (day === 1 && month % 2 === 0 && isEvenMonthFirstDay() && createdDateStr === koreaTodayStr()) {
        // 1~5일 규정만 건너뛰고, 아래 7일 전 규정은 그대로 확인해요
      } else if (day >= 1 && day <= 5 && month % 2 === 0) {
        return {
          ok: false,
          reason: "짝수달 1~5일 사이에 신청한 휴가는 취소할 수 없어요 (경산 팀 규정)"
        };
      }
    }
  }
  const today = todayStr();
  const vacDate = new Date(record.date + "T00:00:00");
  const todayDate = new Date(today + "T00:00:00");
  const diffDays = Math.round((vacDate - todayDate) / 86400000);
  if (diffDays <= 7) {
    return {
      ok: false,
      reason: "휴가일 기준 7일 전부터는 취소할 수 없어요 (경산 팀 규정)"
    };
  }
  return {
    ok: true
  };
}

/* ------------------------------------------------------------------ */
/* 메인 화면 - 월별 달력                                                 */
/* ------------------------------------------------------------------ */
const cal = {
  wrap: {
    minHeight: "100vh",
    background: "#f7f4ee",
    paddingBottom: "40px",
    overflowX: "hidden"
  },
  header: {
    padding: "18px 14px 14px",
    background: "#1b3a5c"
  },
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    rowGap: "8px",
    marginBottom: "10px"
  },
  userName: {
    fontWeight: 700,
    fontSize: "15px",
    color: "#fff",
    whiteSpace: "nowrap",
    marginRight: "8px"
  },
  switchUserBtn: {
    padding: "3px 8px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.4)",
    background: "transparent",
    color: "#cfe0ff",
    fontSize: "11px",
    fontWeight: 700,
    whiteSpace: "nowrap"
  },
  headerBtnRow: {
    display: "flex",
    gap: "5px",
    flexWrap: "wrap",
    justifyContent: "flex-end"
  },
  railDivider: {
    height: 0,
    borderBottom: "2px dashed rgba(255,255,255,0.25)",
    margin: "14px 0 0"
  },
  navRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between"
  },
  navBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(255,255,255,0.14)",
    fontSize: "18px",
    color: "#fff"
  },
  monthTitle: {
    fontSize: "18px",
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "0.5px"
  },
  weekRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    marginTop: "14px",
    textAlign: "center",
    fontSize: "12px",
    color: "#c9d4de"
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: "2px",
    padding: "2px 2px 16px",
    boxSizing: "border-box"
  },
  dayCell: isToday => ({
    minWidth: 0,
    width: "100%",
    minHeight: "82px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    padding: "8px 2px 6px",
    borderRadius: "6px",
    background: "#fff",
    border: "1px solid #e6e0d0",
    outline: isToday ? "2px solid #1b3a5c" : "none",
    outlineOffset: "-2px",
    cursor: "pointer",
    position: "relative",
    boxSizing: "border-box"
  }),
  dayDivider: {
    width: "70%",
    borderBottom: "1px dashed #d8d2c2",
    margin: "5px 0 6px"
  },
  dayNum: type => ({
    fontSize: "16px",
    lineHeight: "18px",
    height: "18px",
    fontWeight: 800,
    color: type === "휴일" ? "#e02020" : type === "토요일" ? "#1a73e8" : "#222"
  }),
  dayCode: type => ({
    fontSize: "14px",
    lineHeight: "16px",
    height: "16px",
    fontWeight: 700,
    color: type === "휴일" ? "#e02020" : type === "토요일" ? "#1a73e8" : "#1a1a1a",
    width: "100%",
    alignSelf: "stretch",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    textAlign: "center",
    boxSizing: "border-box",
    padding: "0 2px"
  }),
  dayBadge: color => ({
    marginTop: "auto",
    width: "24px",
    height: "24px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    fontWeight: 700,
    color: "#fff",
    background: color
  }),
  emptyCell: {
    visibility: "hidden"
  }
};
function badgeColor(count) {
  if (count >= 5) return "#e02020";
  if (count >= 3) return "#f5a623";
  return "#1caa5c";
}

/* ---- 경산 전용: 요일별 보장인원 + 비번 포함시 +1 로직 ---- */
// 보장인원 계산에 포함되는 휴가 종류만 카운트 (병가/교육/노조 등은 기록은 되지만 여유 계산엔 미포함)
const CAPACITY_TYPES = ["연차", "연차비", "분지", "분지비", "장재", "장재비", "지정교번휴무", "검진공가", "연간지", "돌봄"];
function isCapacityType(type) {
  return CAPACITY_TYPES.includes(type);
}

// 삭제/취소 등으로 생긴 순번 구멍을 없애기 위해, 특정 날짜의 남은 보장휴가 순번을 1번부터 다시 매김
// (여러 화면에서 같이 쓰는 공용 함수라 모듈 레벨에 둠 - MainScreen, MyVacationsPanel 등)
function renumberDayPriorities_(dateStr, branch, onDone) {
  VacFacade.getByDate(dateStr, branch).then(records => {
    // 취소된 기록도 그 번호를 계속 차지해요 (취소됐다고 뒷사람이 번호를 당겨쓰지 않아요).
    // 기준은 "지금 순번 순서" 그대로예요 - 짝수달 1일에 손으로 고친 순번이 재정렬로 날아가지 않게,
    // 순서는 유지하고 빈 번호만 메워요. 순번이 없는 기록(비번 짝 등)은 입력 시각 순으로 맨 뒤에 붙어요.
    const capacityAll = (records || []).filter(v => v.branch === branch && isCapacityType(v.vacationType)).sort((a, b) => {
      const pa = a.priority != null && a.priority !== "" ? Number(a.priority) : Infinity;
      const pb = b.priority != null && b.priority !== "" ? Number(b.priority) : Infinity;
      if (pa !== pb) return pa - pb;
      // 같은 순번이거나 둘 다 순번이 없으면 입력 날짜/시간(createdAt) 순서. 없는 기록(옛날 가져오기 등)은 맨 뒤로.
      const ta = timestampToMillis_(a.createdAt);
      const tb = timestampToMillis_(b.createdAt);
      if (ta == null && tb == null) return (a.name || "").localeCompare(b.name || "");
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return ta - tb;
      return (a.name || "").localeCompare(b.name || "");
    });
    const updates = [];
    capacityAll.forEach((v, idx) => {
      const newPriority = idx + 1;
      if (v.priority !== newPriority) {
        updates.push(VacFacade.update(v.branch, v.date, v.id, {
          priority: newPriority
        }));
      }
    });
    return Promise.all(updates).then(() => VacFacade.getByDate(dateStr, branch));
  }).then(freshRecords => {
    // 그날이 속한 달의 달력 캐시를 지워둬요 - 순번이 바뀐 채로 캐시가 오래 남지 않게
    if (freshRecords && onDone) onDone(freshRecords);
  }).catch(err => console.error("순번 재정렬 실패:", err));
}

// 순번 끼워넣기 - 한 사람의 순번을 newPos로 옮기면 사이에 있던 사람들이 한 칸씩 당겨지거나 밀려요.
// 예) 1→4: 기존 2·3·4번이 1·2·3번이 되고 본인이 4번 / 4→1: 기존 1·2·3번이 2·3·4번이 되고 본인이 1번
// 전체 인원보다 큰 번호는 맨 끝 번호로 맞춰요. 최신 데이터를 다시 읽어서 계산하고, 바뀐 사람만 저장해요.
function reorderDayPriority_(record, newPos, onDone) {
  if (!GS_ONLY) return Promise.resolve(); // 문양은 본인 순번 수정 기능 없음 (입력 순서 그대로)
  const branch = record.branch;
  const dateStr = record.date;
  return VacFacade.getByDate(dateStr, branch).then(records => {
    const capacityAll = (records || []).filter(v => v.branch === branch && isCapacityType(v.vacationType)).sort((a, b) => {
      const pa = a.priority != null && a.priority !== "" ? Number(a.priority) : Infinity;
      const pb = b.priority != null && b.priority !== "" ? Number(b.priority) : Infinity;
      if (pa !== pb) return pa - pb;
      const ta = timestampToMillis_(a.createdAt);
      const tb = timestampToMillis_(b.createdAt);
      if (ta == null && tb == null) return (a.name || "").localeCompare(b.name || "");
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return ta - tb;
      return (a.name || "").localeCompare(b.name || "");
    });
    const idx = capacityAll.findIndex(v => v.id === record.id);
    if (idx === -1) throw new Error("기록을 찾지 못했어요. 새로고침 후 다시 시도해주세요.");
    const [moving] = capacityAll.splice(idx, 1);
    const pos = Math.min(Math.max(1, newPos), capacityAll.length + 1);
    capacityAll.splice(pos - 1, 0, moving);
    const updates = [];
    capacityAll.forEach((v, i) => {
      if (v.priority !== i + 1) {
        updates.push(VacFacade.update(v.branch, v.date, v.id, {
          priority: i + 1
        }));
      }
    });
    return Promise.all(updates).then(() => VacFacade.getByDate(dateStr, branch)).then(fresh => {
      if (fresh && onDone) onDone(fresh, pos);
      return pos;
    });
  });
}

// 보장휴가(연차·분지 등)를 순번(priority) 순서로 먼저, 미보장(청휴·병가·노조 등)은 그 아래로 정렬 - 여러 곳에서 재사용
function sortRecordsForDisplay(records) {
  return [...records].sort((a, b) => {
    const groupA = isCapacityType(a.vacationType) ? 0 : 1;
    const groupB = isCapacityType(b.vacationType) ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    const pa = a.priority != null ? a.priority : Infinity;
    const pb = b.priority != null ? b.priority : Infinity;
    if (pa !== pb) return pa - pb;
    return (a.name || "").localeCompare(b.name || "");
  });
}

// 휴충당 신청 목록 정렬 우선순위 - 팀 규정상 정해진 순서예요 (교번 번호 크기순이 아니에요)
const HYUCHUNGDANG_DIA_PRIORITY = ["휴5", "휴6", "휴10", "휴11", "휴13", "휴14", "휴1", "휴2", "휴3", "휴4", "휴7", "휴8", "휴9", "휴12", "휴15"];
function hyuchungdangPriorityIndex_(dia) {
  const idx = HYUCHUNGDANG_DIA_PRIORITY.indexOf(String(dia || "").trim());
  return idx === -1 ? HYUCHUNGDANG_DIA_PRIORITY.length : idx; // 목록에 없는 값은 맨 뒤로
}
function sortHyuchungdangForDisplay(requests) {
  return [...requests].sort((a, b) => {
    // 문양: 신청한 순서(requestedAt) 그대로 - 시각 없는 기록은 맨 뒤
    const ta = timestampToMillis_(a.requestedAt);
    const tb = timestampToMillis_(b.requestedAt);
    if (ta == null && tb != null) return 1;
    if (tb == null && ta != null) return -1;
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return (a.name || "").localeCompare(b.name || "", "ko");
  });
}

// 2026년 공휴일 폴백 목록 (API 호출 실패/오프라인 시에만 사용)
const FALLBACK_HOLIDAYS_2026 = new Set(["2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02", "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-03", "2026-06-06", "2026-07-17", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25"]);

// 수동으로 추가하는 공휴일 (임시공휴일, 선거일 등 API가 놓치는 날짜)
// ⚠️ 필요할 때 이 배열에 "YYYY-MM-DD" 형식으로 날짜만 추가하면 돼요. API 성공 여부와 무관하게 항상 적용됩니다.
// Nager.Date API가 2026년 데이터(제헌절 재지정, 개천절 대체공휴일 등)를 놓치는 경우가 확인되어,
// 2026년 공휴일 전체를 API 결과와 무관하게 항상 보장되도록 넣어뒀어요.
const MANUAL_HOLIDAYS = ["2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02", "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-03", "2026-06-06", "2026-07-17", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25"];

// API가 잘못 포함시키는 날짜(실제로는 근무일)를 매년 자동 제외
// 제헌절(7/17): 2008년~2025년엔 법정 공휴일이 아니었지만, 2026년 2월 법 개정으로 재지정되어
// 2026년 5월 11일 시행 이후(즉 2026년 7월 17일부터)는 다시 정식 공휴일이에요. 그래서 2026년 이후는 제외하지 않아요.
function isExcludedFakeHoliday(dateStr) {
  const isJeheonjeol = dateStr.endsWith("-07-17");
  if (!isJeheonjeol) return false;
  const year = parseInt(dateStr.slice(0, 4), 10);
  return year < 2026; // 2026년 이전 제헌절만 "가짜 공휴일"로 제외
}

// 연도별 공휴일을 Nager.Date API에서 자동 조회 (실패 시 폴백 사용, 2026년 외 연도는 빈 목록)
// + MANUAL_HOLIDAYS는 항상 합쳐서 반환, isExcludedFakeHoliday는 항상 제외
const holidayCache = {};
function fetchHolidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  const manualForYear = MANUAL_HOLIDAYS.filter(d => d.startsWith(String(year)));
  const promise = fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`).then(res => {
    if (!res.ok) throw new Error("holiday fetch failed");
    return res.json();
  }).then(list => {
    const dates = list.map(h => h.date).filter(d => !isExcludedFakeHoliday(d));
    return new Set([...dates, ...manualForYear]);
  }).catch(() => {
    const base = year === 2026 ? FALLBACK_HOLIDAYS_2026 : new Set();
    return new Set([...base, ...manualForYear].filter(d => !isExcludedFakeHoliday(d)));
  });
  holidayCache[year] = promise;
  return promise;
}
function getDayType(dateStr, holidaySet) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=일 6=토
  if (holidaySet && holidaySet.has(dateStr) || day === 0) return "휴일";
  if (day === 6) return "토요일";
  return "평일";
}

// 토요일/휴일엔 일부 DIA가 운휴(운행이 없음)라서 그 사람은 비게 돼요 - 이걸 S1,S2...로 불러요.
const S_CODE_MAP = {
  문양: {
    토요일: ["9d", "10d"],
    휴일: ["7d", "8d", "9d", "10d"]
  }
};

// 안내문구에 "20d(S4)"처럼 참고용으로 같이 보여줄 때 쓰는 함수 - 실제 신청/저장되는 값은
// 절대 안 건드리고, 순전히 "사람이 읽는 문구"에만 괄호로 덧붙여요.
function withSLabel(branch, dateStr, rawCode, holidaySet) {
  const clean = String(rawCode || "").trim();
  if (!clean) return clean;
  // 저장된 값이 "18d"든, 예전에 잘못 들어간 "S2"든 - 일단 항상 실제 코드로 맞춘 다음에 라벨을 붙여요.
  // 이렇게 하면 Firestore 데이터를 직접 안 고쳐도, 화면엔 항상 "18d(S2)" 형태로 통일해서 보여줄 수 있어요.
  const actualCode = normalizeSInput_(branch, dateStr, clean, holidaySet);
  const dayType = getDayType(dateStr, holidaySet);
  const sDiaOrder = S_CODE_MAP[branch] && S_CODE_MAP[branch][dayType] || [];
  const idx = sDiaOrder.indexOf(actualCode);
  if (idx === -1) return actualCode;
  return `${actualCode}(S${idx + 1})`;
}

// 달력칸처럼 좁은 곳에서 쓸 때 - "S4"만 따로 반환해서, 코드보다 작은 글씨로 붙여 넣을 수 있게 해요.
// (withSLabel처럼 한 문자열로 합치면 "20d(S4)"가 칸 너비보다 길어져서 "20d..."로 잘려버려요)
function getSLabelOnly(branch, dateStr, rawCode, holidaySet) {
  const clean = String(rawCode || "").trim();
  if (!clean) return null;
  const actualCode = normalizeSInput_(branch, dateStr, clean, holidaySet);
  const dayType = getDayType(dateStr, holidaySet);
  const sDiaOrder = S_CODE_MAP[branch] && S_CODE_MAP[branch][dayType] || [];
  const idx = sDiaOrder.indexOf(actualCode);
  return idx === -1 ? null : `S${idx + 1}`;
}

// withSLabel의 반대 방향 - 사람이 참고용 라벨("S2")을 실제 코드인 줄 알고 그대로 입력했을 때,
// 저장 직전에 원래 코드("18d")로 자동 교정해요. "S"로 시작하지 않는 입력은 그대로 둬요.
function normalizeSInput_(branch, dateStr, rawInput, holidaySet) {
  const clean = String(rawInput || "").trim();
  const m = /^S(\d+)$/i.exec(clean);
  if (!m) return clean;
  const dayType = getDayType(dateStr, holidaySet);
  const sDiaOrder = S_CODE_MAP[branch] && S_CODE_MAP[branch][dayType] || [];
  const idx = parseInt(m[1], 10) - 1;
  return sDiaOrder[idx] != null ? sDiaOrder[idx] : clean; // 매칭 안 되면 원래 입력 그대로
}

// 날짜 헤더 표시용 색상 - 토요일은 파란색, 휴일(공휴일·일요일)은 빨간색, 평일은 기본색
function dateHeaderColor(dateStr, holidaySet) {
  const type = getDayType(dateStr, holidaySet);
  if (type === "휴일") return "#e02020";
  if (type === "토요일") return "#1a73e8";
  return undefined;
}

// 경산 전용: "3왕복"에 해당하는 교번(DIA) - 평일은 3d·6d, 토요일은 3d.
// 부담이 큰 근무라 기관사들끼리 가급적 휴가를 안 내기로 한 약속이 있어요 (강제는 아니고 안내만).
const THREE_ROUND_TRIP_CODES = {
  평일: ["3d", "6d"],
  토요일: ["3d"]
};
function isThreeRoundTripCode(dateStr, dia, holidaySet) {
  const dayType = getDayType(dateStr, holidaySet);
  const codes = THREE_ROUND_TRIP_CODES[dayType];
  if (!codes) return false;
  return codes.includes(String(dia || "").trim());
}
const GUARANTEE_BY_BRANCH = {
  문양: {
    평일: 5,
    토요일: 7,
    휴일: 8
  }
};

// 소속별 "야간" 근무 교번 - 다음날 자동으로 "비번"이 되는 근무.
// 다음날 정원이 이미 다 찼어도, 전날 야간을 신청한 사람 몫으로 비번 자리가 자동으로 하나 열려야 해요.
// 하드코딩 없이 교번틀(GYOBUN_ORDER) 데이터에서 자동으로 찾아요: 어떤 코드 X의 짝(X+"~", 또는
// X가 "d"로 끝나면 그 앞부분+"~")이 같은 교번틀 안에 있으면 X를 "야간"으로 판단해요.
// 예: 25d의 짝 25~가 교번틀에 있으면 25d는 야간 / 대4의 짝 대4~가 있으면 대4도 야간.
function getNightShiftCodeSet(branch) {
  const teamKey = REVERSE_TEAM_MAP[branch];
  const order = GYOBUN_ORDER[teamKey] || [];
  const codeSet = new Set(order.map(c => String(c).trim()));
  const nightSet = new Set();
  order.forEach(raw => {
    const code = String(raw).trim();
    if (!code || code.endsWith("~")) return;
    const base = code.endsWith("d") ? code.slice(0, -1) : code;
    if (codeSet.has(`${base}~`)) nightSet.add(code);
  });
  return nightSet;
}
function isNightShiftCode(dia, branch) {
  const trimmed = String(dia || "").trim();
  if (!trimmed) return false;
  return getNightShiftCodeSet(branch).has(trimmed);
}

// 야간 근무 신청 시 자동으로 같이 등록/취소되는 "비번" 짝 - 휴가종류 매핑
const NIGHT_COMPANION_TYPE_MAP = {
  연차: "연차비",
  분지: "분지비",
  장재: "장재비",
  병가: "병가비",
  청휴: "청휴비"
};
const NIGHT_COMPANION_TYPES_REVERSE = Object.fromEntries(Object.entries(NIGHT_COMPANION_TYPE_MAP).map(([parent, companion]) => [companion, parent]));

// 오늘 야간 DIA → 다음날 비번 DIA로 변환. 끝이 "d"면 "~"로 바꾸고, 아니면 뒤에 "~"를 붙여요.
// 예: 25d → 25~ / 대4 → 대4~ / 대6 → 대6~
function nightDiaToOffDutyDia(dia) {
  const trimmed = String(dia || "").trim();
  if (/d$/.test(trimmed)) return trimmed.slice(0, -1) + "~";
  return trimmed + "~";
}

// 비번 DIA("25~", "대4~") → 전날 야간 DIA("25d", "대4"). 교번틀에서 실제 야간 코드인 것만 인정해요.
// 야간 짝이 없는 "~" 코드면 null (그냥 일반 휴가로 처리)
function offDutyDiaToNightDia_(dia, branch) {
  const trimmed = String(dia || "").trim();
  if (!trimmed.endsWith("~")) return null;
  const base = trimmed.slice(0, -1);
  const candidates = [base + "d", base];
  return candidates.find(c => isNightShiftCode(c, branch)) || null;
}

// 비번을 먼저 신청하고 나중에 전날 야간을 신청하는 경우 - 다음날 본인 기록이 "이 야간의 비번"으로
// 볼 수 있는 기록인지 확인해요. (DIA가 "~"로 끝나고, 종류가 야간과 같은 계열: 연차↔연차/연차비 등)
// 맞으면 그 기록을 반환 → 새로 만들지 않고 그 기록을 비번 짝(연차비 등)으로 바꿔서 연결해요.
function findCompatibleOffDutyRecord_(nextDayActive, employeeId, nightType) {
  const companionType = NIGHT_COMPANION_TYPE_MAP[nightType];
  if (!companionType) return null;
  const mine = (nextDayActive || []).filter(v => v.employeeId === employeeId);
  if (mine.length !== 1) return null;
  const r = mine[0];
  const dia = String(r.dia || "").trim();
  if (!dia.endsWith("~")) return null;
  return r.vacationType === nightType || r.vacationType === companionType ? r : null;
}

// 날짜 문자열을 하루 앞/뒤로 이동
function shiftDateStr_(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 야간+비번 짝 기록을 찾아서 반대쪽도 같이 취소해요 (한쪽을 취소하면 반대쪽도 자동 취소).
// - record가 "야간"(연차/분지/장재 + 야간교번)이면 → 다음날 비번(연차비 등) 짝을 찾아 취소
// - record가 "비번"(연차비 등, DIA 끝이 "~")이면 → 전날 야간 짝을 찾아 취소
// onPairCancelled(pairRecord)는 짝이 실제로 취소됐을 때 호출되는 콜백 (화면 상태 갱신용).
function cancelNightPairIfAny(record, onPairCancelled) {
  // DIA 표기(25d/25~ 등)에 의존하지 않고, "휴가종류가 연차·분지·장재 ↔ 연차비·분지비·장재비"이고
  // 같은 직원ID로 바로 다음날/전날에 있으면 짝으로 판단해요. (연차비 등은 애초에 야간 다음날
  // 비번 용도로만 쓰여서 DIA 표기가 시트마다 달라도 안전하게 짝을 찾을 수 있어요)
  let pairDate = null;
  let expectCompanion = null;
  if (NIGHT_COMPANION_TYPE_MAP[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, 1);
    expectCompanion = true;
  } else if (NIGHT_COMPANION_TYPES_REVERSE[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, -1);
    expectCompanion = false;
  }
  if (!pairDate) return Promise.resolve(null);

  // 문서 ID를 추측하지 않고, 그 날짜 기록 중 같은 직원ID를 찾아요.
  // (본인이 앱에서 직접 신청한 건 "직원ID_날짜" 고정ID지만, 가져오기/대신기록으로 들어온 건
  //  Firestore가 임의로 만든 ID라서 ID 추측 방식으로는 못 찾기 때문)
  return VacFacade.getByDate(pairDate, record.branch).then(records => {
    const pairRecord = (records || []).find(r => r.employeeId === record.employeeId && r.status !== "취소됨");
    if (!pairRecord) return null;
    const valid = expectCompanion ? !!NIGHT_COMPANION_TYPES_REVERSE[pairRecord.vacationType] : !!NIGHT_COMPANION_TYPE_MAP[pairRecord.vacationType];
    if (!valid) return null;
    return VacFacade.cancel(pairRecord.branch, pairRecord.date, pairRecord.id).then(() => {
      if (onPairCancelled) onPairCancelled(pairRecord);
      return pairRecord;
    });
  }).catch(err => {
    console.error("야간 짝 취소 실패:", err);
    return null;
  });
}

// 야간+비번 짝 기록을 찾아서 반대쪽도 같이 확인(승인) 처리해요 (한쪽을 확인하면 반대쪽도 자동 확인).
// - record가 "야간"(연차/분지/장재 + 야간교번)이면 → 다음날 비번(연차비 등) 짝을 찾아 확인
// - record가 "비번"(연차비 등)이면 → 전날 야간 짝을 찾아 확인
// 이미 확인된 짝이거나 취소된 짝이면 건드리지 않아요.
// onPairConfirmed(pairRecord)는 짝이 실제로 확인됐을 때 호출되는 콜백 (화면 상태 갱신용).
function confirmNightPairIfAny(record, managerName, onPairConfirmed) {
  let pairDate = null;
  let expectCompanion = null;
  if (NIGHT_COMPANION_TYPE_MAP[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, 1);
    expectCompanion = true;
  } else if (NIGHT_COMPANION_TYPES_REVERSE[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, -1);
    expectCompanion = false;
  }
  if (!pairDate) return Promise.resolve(null);
  return VacFacade.getByDate(pairDate, record.branch).then(records => {
    const pairRecord = (records || []).find(r => r.employeeId === record.employeeId && r.status !== "취소됨");
    if (!pairRecord) return null;
    const valid = expectCompanion ? !!NIGHT_COMPANION_TYPES_REVERSE[pairRecord.vacationType] : !!NIGHT_COMPANION_TYPE_MAP[pairRecord.vacationType];
    if (!valid) return null;
    // 짝이 이미 같은 사람으로 확인돼 있으면 손댈 필요 없어요. 그게 아니면(아직 미확인이든,
    // 다른 사람 이름으로 확인돼 있어서 지금 바꾸는 중이든) 항상 이번 확인자로 맞춰줘요 -
    // "최초 확인"과 "확인자 변경" 둘 다 이 한 조건으로 같이 처리돼요.
    if (pairRecord.confirmedBy === managerName) return null;
    return VacFacade.confirm(pairRecord.branch, pairRecord.date, pairRecord.id, managerName).then(() => {
      const confirmedPair = {
        ...pairRecord,
        confirmedBy: managerName
      };
      if (onPairConfirmed) onPairConfirmed(confirmedPair);
      return confirmedPair;
    });
  }).catch(err => {
    console.error("야간 짝 확인 실패:", err);
    return null;
  });
}

/* ------------------------------------------------------------------ */
/* VacFacade - 3단계 전환용 어댑터                                       */
/* USE_DAY_DOCS 스위치 하나로 예전 구조(VacationAPI)/새 구조(VacationDayAPI)*/
/* 중 어디로 보낼지 여기서만 결정해요. 호출하는 쪽 코드는 이 함수들만 쓰면   */
/* 되고, 어느 구조를 쓰는지 신경 안 써도 돼요.                            */
/* 쓰기 계열은 새 구조에서 branch+date가 있어야 문서를 찾을 수 있어서,      */
/* 예전 구조만 쓸 때보다 인자가 하나씩(branch, dateStr) 더 필요해요.       */
/* ------------------------------------------------------------------ */
const VacFacade = {
  getByDate(dateStr, branch) {
    return USE_DAY_DOCS ? window.VacationDayAPI.getByDate(dateStr, branch) : window.VacationAPI.getByDate(dateStr, branch);
  },
  getByRange(startStr, endStr, branch) {
    return USE_DAY_DOCS ? window.VacationDayAPI.getByRange(startStr, endStr, branch) : window.VacationAPI.getByRange(startStr, endStr, branch);
  },
  // 짝수달 1일 오픈 직후 1시간 한정으로만 씀 - 그 외에는 절대 호출하지 마세요
  subscribeRange(startStr, endStr, branch, callback) {
    return USE_DAY_DOCS ? window.VacationDayAPI.subscribeRange(startStr, endStr, branch, callback) : window.VacationAPI.subscribeRange(startStr, endStr, branch, callback);
  },
  // 본인 기록만 날짜 범위로 - 새 구조는 소속이 있어야 서버에서 걸러지니 branch가 항상 필요해요
  getMineByRange(employeeId, branch, fromDate, toDate) {
    return USE_DAY_DOCS ? window.VacationDayAPI.getMineByRange(employeeId, branch, fromDate, toDate) : window.VacationAPI.getMineByRange(employeeId, fromDate, toDate);
  },
  // 본인 신청 전용 - employeeId당 하루 1건 중복 방지가 자동으로 보장돼요
  // guard(선택): 트랜잭션 안에서 최신 기록으로 정원 등을 최종 검사하는 함수 (신구조에서만 적용)
  addOnce(branch, dateStr, employeeId, record, guard) {
    return USE_DAY_DOCS ? window.VacationDayAPI.addOnce(branch, dateStr, employeeId, record, guard) : window.VacationAPI.addOnce(`${employeeId}_${dateStr}`, record);
  },
  // 관리자 대신기록/배정 등 - 같은 사람이 하루에 여러 건 가능
  add(branch, dateStr, record) {
    return USE_DAY_DOCS ? window.VacationDayAPI.add(branch, dateStr, record) : window.VacationAPI.add(record);
  },
  update(branch, dateStr, id, patch) {
    return USE_DAY_DOCS ? window.VacationDayAPI.update(branch, dateStr, id, patch) : window.VacationAPI.update(id, patch);
  },
  cancel(branch, dateStr, id) {
    return USE_DAY_DOCS ? window.VacationDayAPI.cancel(branch, dateStr, id) : window.VacationAPI.cancel(id);
  },
  confirm(branch, dateStr, id, managerName) {
    return USE_DAY_DOCS ? window.VacationDayAPI.confirm(branch, dateStr, id, managerName) : window.VacationAPI.confirm(id, managerName);
  },
  remove(branch, dateStr, id) {
    return USE_DAY_DOCS ? window.VacationDayAPI.remove(branch, dateStr, id) : window.VacationAPI.remove(id);
  },
  // 소속 전체 (백업용) - 날짜 제한 없음
  getAll(branch) {
    return USE_DAY_DOCS ? window.VacationDayAPI.getAll(branch) : window.VacationAPI.getAll(branch);
  },
  // 기준일 이전 오래된 기록 정리 (연 1회 자동 실행)
  deleteOlderThan(cutoffDate) {
    return USE_DAY_DOCS ? window.VacationDayAPI.deleteOlderThan(cutoffDate) : window.VacationAPI.deleteOlderThan(cutoffDate);
  },
  // 소속 전체 삭제 (관리자 "전체 초기화" 버튼)
  removeAllForBranch(branch) {
    return USE_DAY_DOCS ? window.VacationDayAPI.removeAllForBranch(branch) : window.VacationAPI.removeAllForBranch(branch);
  },
  // 가져오기(스프레드시트 일괄 저장) - 새 구조에선 날짜별로 묶어서 bulkSetDays로 한 번에 써요.
  // 두 구조 모두 { branch, date, id } 형태로 통일해서 반환해요 - 되돌리기(undo) 때
  // 이 정보 그대로 VacFacade.remove(branch, date, id)를 호출하면 되게요.
  bulkImport(branch, records) {
    if (!USE_DAY_DOCS) {
      return window.VacationAPI.bulkImport(records).then(ids => ids.map((id, i) => ({
        branch: records[i].branch || branch,
        date: records[i].date,
        id
      })));
    }
    const byDate = {};
    const resultRefs = [];
    records.forEach(r => {
      if (!r.date) return;
      if (!byDate[r.date]) byDate[r.date] = {};
      const entryId = `imp_${Math.random().toString(36).slice(2)}${Date.now()}`;
      const {
        status,
        confirmedBy,
        ...rest
      } = r;
      byDate[r.date][entryId] = {
        ...rest,
        status: status || "정상",
        ...(confirmedBy ? {
          confirmedBy,
          confirmedAt: new Date()
        } : {}),
        createdAt: r.createdAt || new Date(),
        updatedAt: new Date()
      };
      resultRefs.push({
        branch: r.branch || branch,
        date: r.date,
        id: entryId
      });
    });
    return window.VacationDayAPI.bulkSetDays(branch, byDate).then(() => resultRefs);
  }
};

// 야간/비번 짝을 조회만 해요 (취소·확인처럼 뭔가 바꾸지 않고, 있는지/뭔지만 확인) - 수정 시
// "짝이 있는지, 있다면 뭘 맞춰줘야 하는지" 판단하는 데 써요.
function findNightPair(record) {
  let pairDate = null;
  let expectCompanion = null;
  if (NIGHT_COMPANION_TYPE_MAP[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, 1);
    expectCompanion = true;
  } else if (NIGHT_COMPANION_TYPES_REVERSE[record.vacationType]) {
    pairDate = shiftDateStr_(record.date, -1);
    expectCompanion = false;
  }
  if (!pairDate) return Promise.resolve(null);
  return VacFacade.getByDate(pairDate, record.branch).then(records => {
    const pairRecord = (records || []).find(r => r.employeeId === record.employeeId && r.status !== "취소됨");
    if (!pairRecord) return null;
    const valid = expectCompanion ? !!NIGHT_COMPANION_TYPES_REVERSE[pairRecord.vacationType] : !!NIGHT_COMPANION_TYPE_MAP[pairRecord.vacationType];
    return valid ? pairRecord : null;
  }).catch(err => {
    console.error("짝 조회 실패:", err);
    return null;
  });
}

// activeRecords: 취소 아닌 전체 기록 (비번 감지는 전체 기록 대상)
// prevDayActiveRecords: 전날의 취소 아닌 전체 기록 (전날 야간 신청으로 인한 비번 자리 자동 오픈 판별용)
// branch: "문양"
// 참고: 오늘/전날의 요일(평일·토요일·휴일)은 각 날짜별로 실제 계산해서 정원표를 조회하기 때문에,
// 평일→토요일, 토요일→휴일, 휴일→평일 등 요일이 바뀌는 경계에서도 별도 분기 없이 자동으로 맞게 처리돼요.
function gyeongsanCapacity(branch, dateStr, activeRecords, holidaySet, prevDayActiveRecords) {
  const table = GUARANTEE_BY_BRANCH[branch] || GUARANTEE_BY_BRANCH["문양"];
  let base = table[getDayType(dateStr, holidaySet)];
  // 엄격 검증: 비번 +1은 "보장인원에 실제로 자리를 차지하는" 비번일 때만 적용해요.
  // - 오늘: 보장인원 포함 종류이면서 비번인 기록 (DIA가 "25~"처럼 "~"로 끝나거나 "비번" 표기, 또는 연차비/분지비/장재비 같은 야간 짝 종류)
  // - 전날: 야간 DIA이면서, 다음날 짝(비번) 종류가 보장인원 포함인 기록 (연차/분지/장재 야간만 해당)
  //   → 병가·청휴·교육 등 보장인원 미포함 야간/비번은 +1을 열지 않아요.
  // 비번 DIA 표기: "25~", "대4~"처럼 끝이 "~" / 예전 가져오기 데이터의 "대6비번" / 야간 짝 종류(연차비 등)
  const hasOffDutyToday = activeRecords.some(r => {
    if (!isCapacityType(r.vacationType)) return false;
    const dia = String(r.dia || "").trim();
    return dia.endsWith("~") || dia.includes("비번") || !!NIGHT_COMPANION_TYPES_REVERSE[r.vacationType];
  });
  const hasNightFromYesterday = (prevDayActiveRecords || []).some(r => {
    if (!isNightShiftCode(r.dia, branch)) return false;
    const companionType = NIGHT_COMPANION_TYPE_MAP[r.vacationType];
    return !!companionType && isCapacityType(companionType);
  });
  if (hasOffDutyToday || hasNightFromYesterday) base += 1;
  return base;
}
function gyeongsanColor(remain) {
  if (remain <= 0) return "#e02020";
  if (remain === 1) return "#f5a623";
  return "#1caa5c";
}
const TYPE_ICON = {
  // 보장인원 포함
  연차: "🏖️",
  연차비: "🏖️",
  분지: "🌴",
  분지비: "🌴",
  장재: "🛌",
  장재비: "🛌",
  지정교번휴무: "🗓️",
  검진공가: "🩺",
  연간지: "🌙",
  돌봄: "🏖️",
  // 보장인원 미포함 (휴충당)
  청휴: "🌿",
  청휴비: "🌿",
  "청휴(탈상)": "🕯️",
  병가: "🏥",
  병가비: "🏥",
  노조: "🤝",
  공란: "⬜",
  교육: "📚",
  출장: "🧳",
  "교휴(공휴)": "📅"
};

// 보장인원에 포함되지 않는(휴충당 처리) 휴가 종류
const NON_CAPACITY_TYPES = ["청휴", "청휴비", "청휴(탈상)", "병가", "병가비", "노조", "공란", "교육", "출장", "교휴(공휴)", "기타"];
const modal = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "safe flex-end",
    // 내용이 화면보다 커도(PC 확대 등) 위쪽이 안 잘리고 스크롤로 볼 수 있게
    zIndex: 100,
    overflowY: "auto"
  },
  sheet: {
    background: "#fff",
    width: "100%",
    maxWidth: "480px",
    margin: "0 auto",
    maxHeight: "85vh",
    overflowY: "auto",
    borderRadius: "20px 20px 0 0",
    padding: "20px"
  },
  dateTitle: {
    fontSize: "18px",
    fontWeight: 700,
    marginBottom: "4px"
  },
  countText: {
    fontSize: "14px",
    color: "#1a1a1a",
    fontWeight: 600,
    marginBottom: "16px"
  },
  card: {
    background: "#f8f9fb",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "8px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center"
  },
  cancelledCard: {
    opacity: 0.45,
    textDecoration: "line-through"
  },
  name: {
    fontSize: "15px",
    fontWeight: 700
  },
  typeRow: {
    fontSize: "13px",
    color: "#1a1a1a",
    marginTop: "2px"
  },
  dia: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#1b3a5c"
  },
  smallCancelBtn: {
    marginLeft: "10px",
    fontSize: "12px",
    color: "#e02020",
    background: "none",
    border: "none",
    textDecoration: "underline"
  },
  addBtn: {
    width: "100%",
    padding: "14px",
    marginTop: "8px",
    borderRadius: "12px",
    border: "none",
    background: "#1b3a5c",
    color: "#fff",
    fontSize: "15px",
    fontWeight: 700
  },
  closeBtn: {
    width: "100%",
    padding: "14px",
    marginTop: "8px",
    borderRadius: "12px",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#666",
    fontSize: "15px",
    fontWeight: 600
  },
  formRow: {
    marginBottom: "14px"
  },
  label: {
    fontSize: "13px",
    color: "#666",
    marginBottom: "6px",
    display: "block"
  },
  input: {
    width: "100%",
    padding: "12px",
    fontSize: "15px",
    borderRadius: "10px",
    border: "1px solid #ddd"
  },
  typeChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "8px"
  },
  chip: active => ({
    padding: "8px 14px",
    borderRadius: "999px",
    border: active ? "1px solid #1b3a5c" : "1px solid #ddd",
    background: active ? "#eaf1ff" : "#fff",
    color: active ? "#1b3a5c" : "#666",
    fontSize: "13px",
    fontWeight: 600
  })
};
const VACATION_TYPES = [...CAPACITY_TYPES, ...NON_CAPACITY_TYPES];
const tbl = {
  th: {
    padding: "5px 3px",
    textAlign: "center",
    fontSize: "11px",
    color: "#666",
    whiteSpace: "nowrap"
  },
  td: {
    padding: "7px 4px",
    textAlign: "center",
    verticalAlign: "top",
    fontSize: "13px",
    whiteSpace: "nowrap"
  }
};
function pad2(n) {
  return String(n).padStart(2, "0");
}
function MainScreen({
  currentUser: realCurrentUser,
  employees,
  managers,
  onSwitchUser
}) {
  const isSuperAdmin = isSuperAdminUser(realCurrentUser);
  // 소속 전환 기능은 소속별 전용 앱이 되면서 없앴어요 - 아래 조건문들 호환용으로 항상 false
  const ghosting = false;
  // 슈퍼관리자(권재림)는 "운용" 버튼으로 기관사↔운용 화면을 자유롭게 오갈 수 있어요.
  // 운용으로 등록돼있지 않아도 이 토글로 운용 화면(대신 기록·확인·휴충당 관리 등)에 들어갈 수 있어요.
  const [actingAsManager, setActingAsManager] = useState(false);
  const currentUser = realCurrentUser;
  const isAdmin = isAdminUser(currentUser);
  const isMidManager = isMidManagerUser(currentUser, managers) || isSuperAdmin && actingAsManager;
  const [showAdmin, setShowAdmin] = useState(false);
  const [showManagerAdmin, setShowManagerAdmin] = useState(false);
  const [showImportTest, setShowImportTest] = useState(false);
  const [showMyVacations, setShowMyVacations] = useState(false);
  const [showLotteryAdmin, setShowLotteryAdmin] = useState(false); // 명절 추첨 관리 (관리자)
  const [showLotteryApply, setShowLotteryApply] = useState(false); // 명절 추첨 응모 (기관사)
  const [showHyuchungdangAdmin, setShowHyuchungdangAdmin] = useState(false); // 휴충당 관리 (관리자, 경산 전용)
  const [showAdminMenu, setShowAdminMenu] = useState(false); // 관리자 메뉴 모음
  const [showRosterChange, setShowRosterChange] = useState(false); // 교번 변경 예약 (관리자)
  const [showDataReset, setShowDataReset] = useState(false); // 데이터 초기화·수동 백업
  const [lastBackupText, setLastBackupText] = useState("확인 중...");

  // 관리자 메뉴를 열 때마다 마지막 백업 시각을 최신으로 다시 확인해요
  useEffect(() => {
    if (!showAdminMenu) return;
    let cancelled = false;
    waitForFirestore().then(() => {
      if (!window.SystemAPI || typeof window.SystemAPI.getBackupMeta !== "function") {
        throw new Error("no-system-api");
      }
      return window.SystemAPI.getBackupMeta();
    }).then(meta => {
      var _meta$lastBackupAt;
      if (cancelled) return;
      const ms = meta !== null && meta !== void 0 && (_meta$lastBackupAt = meta.lastBackupAt) !== null && _meta$lastBackupAt !== void 0 && _meta$lastBackupAt.toMillis ? meta.lastBackupAt.toMillis() : null;
      if (!ms) {
        setLastBackupText("아직 백업된 적 없어요");
        return;
      }
      const diffDays = Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
      const d = new Date(ms);
      const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      setLastBackupText(diffDays <= 0 ? `${dateStr} (오늘)` : `${dateStr} (${diffDays}일 전)`);
    }).catch(() => {
      if (!cancelled) setLastBackupText("확인 실패");
    });
    return () => {
      cancelled = true;
    };
  }, [showAdminMenu]);
  const [showEtiquetteNotice, setShowEtiquetteNotice] = useState(true); // 로그인할 때마다 한 번 안내
  const [upcomingUnconfirmed, setUpcomingUnconfirmed] = useState([]); // 5일 이내 & 아직 미확인인 내 신청 건
  const [lotteryResultsToShow, setLotteryResultsToShow] = useState([]); // 아직 확인 안 한 명절 추첨 결과
  const [hyuchungdangResultsToShow, setHyuchungdangResultsToShow] = useState([]); // 아직 확인 안 한 휴충당 확정 결과
  const [branchUpcomingUnconfirmed, setBranchUpcomingUnconfirmed] = useState([]); // 운용용 - 소속 전체의 5일 이내 미확인 신청
  const [adjacentRecords, setAdjacentRecords] = useState({
    prev: [],
    next: []
  }); // 운용용 - 전날/다음날 요약

  // 경산 전용 - "전날 낮12시" ~ "오픈 당일 오전 9시"(오픈 시각)까지 공지
  const evenMonthOpenInfo = (() => {
    if (!GS_ONLY) return null;
    const nowUtcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
    const nowKst = new Date(nowUtcMs + 9 * 60 * 60000);
    const hour = nowKst.getHours();
    const minute = nowKst.getMinutes();
    const isEvenMonthFirst = d => d.getDate() === 1 && (d.getMonth() + 1) % 2 === 0;
    const todayLocal = new Date(nowKst.getFullYear(), nowKst.getMonth(), nowKst.getDate());
    let openDate = null;
    let isOpeningToday = false;
    if (isEvenMonthFirst(todayLocal) && hour < 9) {
      // 오픈 당일 오전 9시 전까지 (08:59까지 표시, 09:00부터 사라짐)
      openDate = todayLocal;
      isOpeningToday = true;
    } else {
      const tomorrow = new Date(todayLocal);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (isEvenMonthFirst(tomorrow) && hour >= 12) {
        // 오픈 전날 낮12시부터
        openDate = tomorrow;
        isOpeningToday = false;
      }
    }
    if (!openDate) return null;
    const openMonth = openDate.getMonth() + 1;
    const openYear = openDate.getFullYear();
    const wrap = (m, y) => m > 12 ? {
      m: m - 12,
      y: y + 1
    } : {
      m,
      y
    };
    const next1 = wrap(openMonth + 1, openYear);
    const next2 = wrap(openMonth + 2, openYear);
    return {
      openMonth,
      openYear,
      isOpeningToday,
      next1Month: next1.m,
      next1Year: next1.y,
      next2Month: next2.m,
      next2Year: next2.y
    };
  })();
  // PC(넓은 화면)인지 감지 - index.html의 PC용 zoom 미디어쿼리와 같은 640px 기준
  const [isWideScreen, setIsWideScreen] = useState(typeof window !== "undefined" && window.innerWidth >= 640);
  useEffect(() => {
    const onResize = () => setIsWideScreen(window.innerWidth >= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // PC 3칸 모드에서 - 마우스로 날짜 모달 창을 드래그해서 옮기고, 아래쪽으로만 높이를 조절
  // (스와이프 애니메이션과 동일하게, 리렌더 없이 DOM을 직접 움직여서 끊김 없이 부드럽게)
  // 기본 위치는 left:50%+transform, top:vh 같은 CSS 단위로 잡아요 - window.innerWidth 같은 JS 계산값을
  // 쓰면 브라우저 화면 배율(줌)이 바뀔 때 리렌더가 안 일어나 위치가 어긋날 수 있어서, 브라우저가 항상
  // 알아서 다시 계산해주는 CSS 단위를 써요. 드래그한 만큼만 추가로 옮겨요.
  const DAY_MODAL_DEFAULT_W = 1498; // 너비는 고정 (1152에서 30% 추가 증가)
  const [dragPos, setDragPos] = useState({
    x: 0,
    y: 0
  });
  const dragStateRef = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    baseX: 0,
    baseY: 0
  });
  const dayModalSheetRef = useRef(null); // 크기 조절 시 현재 크기를 재는 용도
  const [heightOverride, setHeightOverride] = useState(null); // 직접 조절한 높이(px, null이면 기본 76vh), 너비는 항상 고정
  const resizeStateRef = useRef({
    resizing: false,
    startY: 0,
    startH: 0
  });
  const dayModalWidth = DAY_MODAL_DEFAULT_W;
  const dayModalHeightStyle = heightOverride != null ? `${heightOverride}px` : "94vh";
  const handleDragStart = e => {
    dragStateRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      baseX: dragPos.x,
      baseY: dragPos.y
    };
  };
  const handleResizeStart = e => {
    e.stopPropagation();
    const rect = dayModalSheetRef.current ? dayModalSheetRef.current.getBoundingClientRect() : null;
    resizeStateRef.current = {
      resizing: true,
      startY: e.clientY,
      startH: rect ? rect.height : 600
    };
  };
  useEffect(() => {
    let rafId = null;
    let pendingEvent = null;
    const applyFrame = () => {
      rafId = null;
      const e = pendingEvent;
      if (!e || !dayModalSheetRef.current) return;
      const d = dragStateRef.current;
      if (d.dragging) {
        const x = d.baseX + (e.clientX - d.startX);
        const y = d.baseY + (e.clientY - d.startY);
        dayModalSheetRef.current.style.transform = `translate(calc(-50% + ${x}px), ${y}px)`;
      }
      const r = resizeStateRef.current;
      if (r.resizing) {
        const nextH = Math.max(300, r.startH + (e.clientY - r.startY));
        dayModalSheetRef.current.style.height = `${nextH}px`;
      }
    };
    const onMove = e => {
      if (!dragStateRef.current.dragging && !resizeStateRef.current.resizing) return;
      pendingEvent = e;
      if (rafId == null) rafId = requestAnimationFrame(applyFrame);
    };
    const onUp = e => {
      if (dragStateRef.current.dragging) {
        dragStateRef.current.dragging = false;
        setDragPos({
          x: dragStateRef.current.baseX + (e.clientX - dragStateRef.current.startX),
          y: dragStateRef.current.baseY + (e.clientY - dragStateRef.current.startY)
        });
      }
      if (resizeStateRef.current.resizing) {
        resizeStateRef.current.resizing = false;
        const rs = resizeStateRef.current;
        const nextH = Math.max(300, rs.startH + (e.clientY - rs.startY));
        setHeightOverride(nextH);
      }
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // 본인 기록 찾기 - 이름+소속으로 우선 찾아요 (스프레드시트에서 "직원ID는 고정, 이름을 서로
  // 바꿔서 자리를 교체하는" 운영 방식과 맞추기 위해서예요 - 교번앱도 이 방식으로 동작해요).
  // 혹시 이름이 명단에서 아예 안 보이면 ID로도 한 번 더 찾아봐요 (최후의 안전장치).
  const myRosterEntry = (employees || []).find(e => e.name === currentUser.name && e.branch === currentUser.branch) || (employees || []).find(e => e.id === currentUser.id);
  const myCode = (myRosterEntry === null || myRosterEntry === void 0 ? void 0 : myRosterEntry.code) || "";
  const myBaseCode = (myRosterEntry === null || myRosterEntry === void 0 ? void 0 : myRosterEntry.baseCode) || "";
  const myTeamKey = REVERSE_TEAM_MAP[currentUser.branch];
  const myOrder = GYOBUN_ORDER[myTeamKey] || [];

  // "대신 기록" DIA 드롭다운용 - 교번틀 코드 목록 (자기 소속 기준)
  const managerBranchEmployees = (employees || []).filter(e => e.branch === currentUser.branch);
  const managerTemplateCodes = myOrder.filter(c => managerBranchEmployees.some(e => e.code === c));
  const managerOtherCodes = [...new Set(managerBranchEmployees.map(e => e.code))].filter(c => !managerTemplateCodes.includes(c));
  const managerBranchCodes = [...managerTemplateCodes, ...managerOtherCodes];

  // 확인란 드롭다운용 - 본인 소속 운용 명단 (이름순)
  const branchManagerNames = (managers || []).filter(m => m.branch === currentUser.branch).map(m => m.name).sort((a, b) => a.localeCompare(b, "ko"));

  // 특정 날짜의 본인 교번을 계산 (기준일 대비 날짜차이만큼 교번틀을 밀어서)
  const codeForDate = dateStr => {
    if (!BASE_DATE || !myOrder.length) return "";
    // 교번 변경 예약이 있으면 그 날짜에 앉아 있는 자리의 교번으로 계산
    const bc = baseCodeForPersonOnDate_(employees, currentUser.name, currentUser.branch, dateStr, myBaseCode);
    if (!bc) return "";
    const offset = diffDays_(BASE_DATE, dateStr);
    return shiftCodeByDays_(myOrder, bc, offset);
  };
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-indexed
  const [monthMap, setMonthMap] = useState({}); // { "YYYY-MM-DD": [records] }
  // 짝수달 1일 오전 9시 진입/10시 퇴장을 놓치지 않도록 1분마다 다시 확인하되, 실제로 그 시간대에
  // 들어가고 나갈 때만 값이 바뀌게 해요. (예전엔 매분 값이 무조건 바뀌어서, 평상시에도 1분마다
  // 달력을 계속 다시 불러오는 낭비가 있었어요 - 이제는 평상시엔 이 값이 그대로 유지돼요.)
  const [inPeakWindow, setInPeakWindow] = useState(() => GS_ONLY && isPeakOpeningWindow());
  useEffect(() => {
    const check = () => {
      const val = GS_ONLY && isPeakOpeningWindow();
      setInPeakWindow(prev => prev === val ? prev : val);
    };
    check();
    const id = setInterval(check, 60 * 1000);
    return () => clearInterval(id);
  }, [currentUser.branch]);
  const [loading, setLoading] = useState(true);
  const [holidaySet, setHolidaySet] = useState(new Set());
  const [selectedDate, setSelectedDate] = useState(null); // 모달용
  // 날짜 모달이 닫힐 때마다 드래그 위치/크기 초기화 (다음에 열 때는 항상 기본 상태로 시작)
  useEffect(() => {
    if (!selectedDate) {
      setDragPos({
        x: 0,
        y: 0
      });
      setHeightOverride(null);
    }
  }, [selectedDate]);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [formType, setFormType] = useState(VACATION_TYPES[0]);
  const [formDia, setFormDia] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingPriorityId, setEditingPriorityId] = useState(null); // 순번 수정 중인 기록 id
  const [priorityInput, setPriorityInput] = useState("");
  const [editingNoteId, setEditingNoteId] = useState(null); // 비고 수정 중인 기록 id
  const [editingConfirmId, setEditingConfirmId] = useState(null); // 확인자 수정 중인 기록 id
  const [noteInput, setNoteInput] = useState("");

  // 중간관리자 - 대신 기록 폼 상태
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [managerTargetId, setManagerTargetId] = useState("");
  const [managerFormType, setManagerFormType] = useState(NON_CAPACITY_TYPES[0]);
  const [managerFormDia, setManagerFormDia] = useState("");
  const [managerFormNote, setManagerFormNote] = useState("");
  const [managerFormOtherReason, setManagerFormOtherReason] = useState(""); // "기타" 선택 시 사유
  const [managerFormUnassigned, setManagerFormUnassigned] = useState(false); // 대상자 미정으로 먼저 등록
  const [managerSaving, setManagerSaving] = useState(false);
  // 휴충당 신청 (경산 전용) - 본인 교번이 "휴"로 시작하는 날짜에 한해, 언제든 신청 가능.
  // 상태는 "신청중"/"취소됨" 두 가지만 써요. 확정 처리는 별도의 "휴충당 신청 현황" 달력에서 운용이 처리해요.
  const [hyuchungdangByDate, setHyuchungdangByDate] = useState([]);
  useEffect(() => {
    if (!selectedDate) {
      setHyuchungdangByDate([]);
      return;
    }
    let cancelled = false;
    waitForFirestore().then(() => window.HyuchungdangAPI.listByDate(selectedDate, currentUser.branch)).then(list => {
      if (cancelled) return;
      setHyuchungdangByDate((list || []).filter(r => r.status === "신청중"));
    }).catch(err => console.error("휴충당 신청 목록 조회 실패:", err));
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);
  const myHyuchungdangRequest = hyuchungdangByDate.find(r => r.employeeId === currentUser.id);
  const handleApplyHyuchungdang = () => {
    if (!confirm(`${selectedDate}에 휴충당을 신청할까요?`)) return;
    const id = `${currentUser.id}_${selectedDate}`;
    const originalDia = codeForDate(selectedDate);
    window.HyuchungdangAPI.request(id, {
      employeeId: currentUser.id,
      name: currentUser.name,
      branch: currentUser.branch,
      date: selectedDate,
      originalDia
    }).then(() => {
      setHyuchungdangByDate(prev => [...prev, {
        id,
        employeeId: currentUser.id,
        name: currentUser.name,
        branch: currentUser.branch,
        date: selectedDate,
        originalDia,
        status: "신청중"
      }]);
    }).catch(err => alert("신청 실패: " + (err && err.message ? err.message : err)));
  };
  const handleCancelHyuchungdang = reqId => {
    if (!confirm("휴충당 신청을 취소할까요?")) return;
    window.HyuchungdangAPI.cancel(reqId).then(() => setHyuchungdangByDate(prev => prev.filter(r => r.id !== reqId))).catch(err => alert("취소 실패: " + (err && err.message ? err.message : err)));
  };
  useEffect(() => {
    let cancelled = false;
    fetchHolidays(viewYear).then(set => {
      if (!cancelled) setHolidaySet(set);
    });
    return () => {
      cancelled = true;
    };
  }, [viewYear]);

  // 앱 접속(로그인) 시 한 번 - 본인이 신청한 것 중 5일 이내인데 아직 운용 확인 전인 건 알림
  // (몇 년치 전체 이력이 아니라, 딱 "오늘~5일 후" 구간만 좁혀서 읽어와요 - 로그인마다 나가는
  //  조회라 여기서 아끼는 게 누적 효과가 커요)
  useEffect(() => {
    if (isMidManager) return; // 운용은 본인이 확인 주체라 대상 아님
    const today = todayStr();
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() + 5);
    const limit = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    waitForFirestore().then(() => VacFacade.getMineByRange(currentUser.id, currentUser.branch, today, limit)).then(records => {
      const upcoming = (records || []).filter(v => v.status !== "취소됨" && !v.confirmedBy && isCapacityType(v.vacationType)).sort((a, b) => a.date.localeCompare(b.date));
      setUpcomingUnconfirmed(upcoming);
    }).catch(err => console.error("확인 대기 알림 조회 실패:", err));
  }, [currentUser.id]);

  // 1주일 1회 자동 백업 - 관리자/운용이 앱을 열 때마다 확인해서, 마지막 백업 이후 1주일(BACKUP_INTERVAL_MS)이
  // 지났으면 그 자리에서 바로 전체 휴가 데이터를 스프레드시트("앱_자동백업" 탭)로 백업해요. 서버
  // 스케줄러가 없는 구조라 "누군가 앱을 열 때 확인"하는 방식이에요 (특정 시간대를 기다리지 않아요).
  // ⚠️ 앱을 켜자마자 바로 실행하지 않고, 초기 화면(교번 등)이 다 자리잡은 뒤(15초 후)로 늦춰서
  // 실행해요 - 교번 데이터는 이제 별도 캐시로 즉시 뜨긴 하지만, 혹시 모를 자원 경합을 피하려고요.
  useEffect(() => {
    if (!isAdmin && !isMidManager || !GS_ONLY) return;
    const timer = setTimeout(() => {
      waitForFirestore().then(() => window.SystemAPI.getBackupMeta()).then(meta => {
        var _meta$lastBackupAt2;
        const lastMs = meta !== null && meta !== void 0 && (_meta$lastBackupAt2 = meta.lastBackupAt) !== null && _meta$lastBackupAt2 !== void 0 && _meta$lastBackupAt2.toMillis ? meta.lastBackupAt.toMillis() : 0;
        const overdueMs = Date.now() - lastMs;
        if (overdueMs < BACKUP_INTERVAL_MS) return null; // 아직 1주일 안 지남
        // Promise.resolve().then()으로 한 번 감싸서, VacFacade.getAll 자체가 즉시(동기적으로)
        // 오류를 던지는 경우(예: index.html이 최신이 아니라 함수가 아예 없는 경우)에도
        // 아래 타임아웃·에러 처리가 정상적으로 붙잡을 수 있게 해요.
        return promiseWithTimeout(Promise.resolve().then(() => VacFacade.getAll(currentUser.branch)), 90000, "백업").then(records => {
          const payload = (records || []).map(r => ({
            date: r.date || "",
            name: r.name || "",
            branch: r.branch || "",
            employeeId: r.employeeId || "",
            vacationType: r.vacationType || "",
            dia: r.dia == null ? "" : String(r.dia),
            status: r.status || "",
            confirmedBy: r.confirmedBy || "",
            priority: r.priority == null ? "" : r.priority,
            // 신청일(YYYY-MM-DD) - "가져오기"에서 신청일을 읽던 것과 반대로, 나중에 이 백업을
            // 다시 불러올(복구) 기능을 만들 때 그대로 재사용할 수 있도록 남겨둬요.
            reqDate: r.createdAt ? formatEntryDateOnly(r.createdAt) : "",
            note: r.note || "",
            recordedBy: r.recordedBy || ""
          })).sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            const pa = a.priority === "" ? Infinity : a.priority;
            const pb = b.priority === "" ? Infinity : b.priority;
            if (pa !== pb) return pa - pb;
            return a.name.localeCompare(b.name, "ko");
          });
          return fetchWithTimeout(VACATION_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "text/plain;charset=utf-8"
            },
            body: JSON.stringify({
              action: "backup",
              records: payload
            })
          }).then(res => res.json()).then(json => {
            if (!json || !json.ok) throw new Error(json && json.error || "백업 실패");
            return window.SystemAPI.markBackupDone();
          });
        });
      }).catch(err => console.error("자동 백업 실패:", err));
    }, 15000);
    return () => clearTimeout(timer);
  }, [currentUser.id, currentUser.branch, isAdmin, isMidManager]);

  // 앱 접속(로그인) 시 한 번 - 기관사, 오늘 추첨된 이벤트의 결과만 하루 동안 알림 (매너팝업 대신 단독으로)
  useEffect(() => {
    if (isMidManager) return;
    waitForFirestore().then(() => Promise.all([loadCachedList(LOTTERY_EVENTS_CACHE_KEY, LOTTERY_EVENTS_CACHE_TTL_MS, () => window.LotteryAPI.listEvents()), window.LotteryAPI.listMyEntries(currentUser.id)])).then(([events, entries]) => {
      const today = koreaTodayStr();
      const drawnTodayEventIds = new Set((events || []).filter(e => e.status === "추첨완료" && e.updatedAt && formatEntryDateOnly(e.updatedAt) === today).map(e => e.id));
      const results = (entries || []).filter(en => en.result !== "대기중" && drawnTodayEventIds.has(en.eventId));
      setLotteryResultsToShow(results);
    }).catch(err => console.error("명절 추첨 결과 조회 실패:", err));
  }, [currentUser.id]);

  // 앱 접속(로그인) 시 한 번 - 경산 기관사, 운용이 확인까지 마친(=확정된) 휴충당 중
  // 아직 그 전날(휴충당 날짜 하루 전) 자정이 지나지 않은 것만 알림. 한 번 닫아도
  // 다음에 다시 들어오면 그 날짜가 되기 전까지는 계속 다시 떠요.
  useEffect(() => {
    if (isMidManager) return;
    const today = koreaTodayStr();
    waitForFirestore().then(() => window.HyuchungdangAPI.listMineFrom(currentUser.id, today)).then(list => {
      const results = (list || []).filter(r => r.confirmedBy && r.status !== "취소됨");
      setHyuchungdangResultsToShow(results);
    }).catch(err => console.error("휴충당 확정 알림 조회 실패:", err));
  }, [currentUser.id]);

  // 앱 접속(로그인) 시 한 번 - 운용용, 소속 전체에서 5일 이내인데 아직 미확인인 신청 알림
  useEffect(() => {
    if (!isMidManager) return;
    const today = todayStr();
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() + 5);
    const limit = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    waitForFirestore().then(() => VacFacade.getByRange(today, limit, currentUser.branch)).then(records => {
      const upcoming = (records || []).filter(v => v.status !== "취소됨" && !v.confirmedBy && isCapacityType(v.vacationType)).sort((a, b) => a.date.localeCompare(b.date));
      setBranchUpcomingUnconfirmed(upcoming);
    }).catch(err => console.error("운용 확인 대기 알림 조회 실패:", err));
  }, [currentUser.id, currentUser.branch, isMidManager]);
  const loadMonth = useCallback((y, m) => {
    setLoading(true);
    const start = `${y}-${pad2(m + 1)}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const end = `${y}-${pad2(m + 1)}-${pad2(lastDay)}`;
    waitForFirestore().then(() => VacFacade.getByRange(start, end, currentUser.branch)).then(list => {
      const map = {};
      (list || []).forEach(v => {
        if (!map[v.date]) map[v.date] = [];
        map[v.date].push(v);
      });
      Object.values(map).forEach(arr => arr.sort((a, b) => (a.name || "").localeCompare(b.name || "")));
      setMonthMap(map);
    }).catch(err => {
      console.error(err);
      alert("데이터를 불러오지 못했어요: " + (err && err.message ? err.message : err));
    }).finally(() => setLoading(false));
  }, [currentUser.branch]);

  // 보고 있는 달이 바뀌거나(월 이동) 소속이 바뀌면(고스트모드 전환) 한 번만 다시 불러와요.
  // (예전엔 항상 실시간 구독(onSnapshot)이었는데, 무료 읽기 한도를 최대한 아끼려고
  //  "켜놓은 동안 계속 감시"가 아니라 "필요할 때 한 번 조회"로 되돌렸어요.
  //  다른 사람이 그 사이에 신청/취소해도 자동으로는 안 보이고, 화면을 나갔다 들어오거나
  //  월을 넘겼다 다시 돌아오거나, 새로고침하면 그때 최신 상태로 반영돼요.
  //  본인이 직접 신청/취소/확인한 건 각 처리 함수에서 즉시 화면에 반영하니 이 effect와 무관해요.
  //
  //  ⭐ 딱 하나 예외: 경산 짝수달 1일 오전 9시대(오픈 직후, 신청이 몰리는 그 1시간)만
  //  자동으로 실시간 구독을 켜요. 새 구조(vacation_days)는 날짜당 문서 1개라 구독 비용도
  //  하루 최대 31개뿐이라 예전(직원+날짜별) 구조보다 훨씬 저렴해요. 그 시간대가 지나면
  //  자동으로 구독을 끊고 평소의 안전한 1회 조회 방식으로 돌아가요.)
  useEffect(() => {
    const start = `${viewYear}-${pad2(viewMonth + 1)}-01`;
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    const end = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(lastDay)}`;
    if (inPeakWindow) {
      setLoading(true);
      let cancelled = false;
      let unsubscribe = null;
      waitForFirestore().then(() => {
        if (cancelled) return;
        unsubscribe = VacFacade.subscribeRange(start, end, currentUser.branch, list => {
          const map = {};
          (list || []).forEach(v => {
            if (!map[v.date]) map[v.date] = [];
            map[v.date].push(v);
          });
          Object.values(map).forEach(arr => arr.sort((a, b) => (a.name || "").localeCompare(b.name || "")));
          setMonthMap(map);
          setLoading(false);
        });
      });
      return () => {
        cancelled = true;
        if (unsubscribe) unsubscribe();
      };
    }

    // 살짝(200ms) 지연을 둬서, ‹ › 를 빠르게 여러 번 눌러 여러 달을 휙휙 지나칠 때
    // 지나친 중간 달들까지 전부 조회하지 않고 최종적으로 멈춘 달만 조회하게 해요.
    // 최신성엔 전혀 영향 없고, 순전히 낭비되는 중간 요청만 없애는 거예요.
    const timer = setTimeout(() => {
      loadMonth(viewYear, viewMonth);
    }, 200);
    return () => clearTimeout(timer);
  }, [viewYear, viewMonth, currentUser.branch, loadMonth, inPeakWindow]);
  const changeMonth = delta => {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    if (m > 11) {
      m = 0;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  };
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayKey = todayStr();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const openDate = d => {
    const key = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(d)}`;
    setSelectedDate(key);
    setShowRegisterForm(false);
    setShowManagerForm(false);
    setFormType(VACATION_TYPES[0]);
    setFormDia(codeForDate(key)); // 선택한 날짜의 실제 교번 (기준일 대비 계산, 수정 가능)
    window.history.pushState({
      modal: true
    }, "");
  };

  // 날짜 상세 모달 안에서 이전/다음 날짜로 바로 이동 (화살표 버튼 + 스와이프 공용)
  const changeDay = delta => {
    if (!selectedDate) return;
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    const newYear = d.getFullYear();
    const newMonth = d.getMonth();
    const newDateStr = `${newYear}-${pad2(newMonth + 1)}-${pad2(d.getDate())}`;
    if (newYear !== viewYear || newMonth !== viewMonth) {
      setViewYear(newYear);
      setViewMonth(newMonth);
    }
    setSelectedDate(newDateStr);
    setShowRegisterForm(false);
    setShowManagerForm(false);
    setFormType(VACATION_TYPES[0]);
    setFormDia(codeForDate(newDateStr));
  };

  // 날짜 모달/사이드 패널(내 휴가현황·승인 관리·운용 인원·가져오기 테스트) 공통으로 쓰는 닫기 함수.
  // 뒤로가기 버튼을 눌러도 popstate 핸들러가 똑같이 처리해서, 항상 달력 화면으로 돌아가요.
  const closeModal = () => {
    if (selectedDate || showAdmin || showManagerAdmin || showImportTest || showMyVacations || showLotteryAdmin || showLotteryApply || showHyuchungdangAdmin || showAdminMenu || showDataReset || showRosterChange) {
      window.history.back();
    }
  };

  // 사이드 패널을 열 때 히스토리를 하나 쌓아서, 뒤로가기 시 popstate로 자동 닫히게 함
  const openPanel = setter => {
    window.history.pushState({
      modal: true
    }, "");
    setter(true);
  };

  // 뒤로가기/닫기 시 순번 수정 중이던 값을 자동 저장하기 위한 ref (stale closure 방지)
  const editingPriorityRef = useRef(null);

  // 안드로이드/브라우저 뒤로가기 버튼을 누르면 앱을 나가는 대신 모달/패널만 닫히도록 처리
  useEffect(() => {
    const handlePopState = () => {
      if (editingPriorityRef.current) {
        const {
          record,
          input
        } = editingPriorityRef.current;
        const num = parseInt(input, 10);
        if (!Number.isNaN(num) && num >= 1 && num !== record.priority) {
          reorderDayPriority_(record, num).catch(err => console.error("순번 자동저장 실패:", err));
        }
        editingPriorityRef.current = null;
      }
      setSelectedDate(null);
      setShowRegisterForm(false);
      setShowManagerForm(false);
      setShowAdmin(false);
      setShowManagerAdmin(false);
      setShowImportTest(false);
      setShowMyVacations(false);
      setShowLotteryAdmin(false);
      setShowLotteryApply(false);
      setShowHyuchungdangAdmin(false);
      setShowAdminMenu(false);
      setShowDataReset(false);
      setShowRosterChange(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // 전날/다음날 날짜 문자열 계산
  const prevDateStr = selectedDate ? (() => {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  })() : null;
  const nextDateStr = selectedDate ? (() => {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  })() : null;

  // 운용(중간관리자)만 - 전날/다음날 기록을 따로 옆에 보여줌.
  // 이미 이번 달 데이터(monthMap)에 있는 날짜면 그걸 그대로 쓰고, 달 경계를 넘어가는 날짜만
  // (예: 1일의 전날, 말일의 다음날) 서버에서 따로 조회해요 - 불필요한 중복 조회를 줄여요.
  useEffect(() => {
    if (!isMidManager || !isWideScreen || !selectedDate) {
      setAdjacentRecords({
        prev: [],
        next: []
      });
      return;
    }
    const selectedMonth = selectedDate.slice(0, 7);
    const prevInSameMonth = prevDateStr && prevDateStr.slice(0, 7) === selectedMonth;
    const nextInSameMonth = nextDateStr && nextDateStr.slice(0, 7) === selectedMonth;
    let cancelled = false;
    const prevPromise = prevInSameMonth ? Promise.resolve((monthMap[prevDateStr] || []).filter(v => v.branch === currentUser.branch)) : prevDateStr ? waitForFirestore().then(() => VacFacade.getByDate(prevDateStr, currentUser.branch)) : Promise.resolve([]);
    const nextPromise = nextInSameMonth ? Promise.resolve((monthMap[nextDateStr] || []).filter(v => v.branch === currentUser.branch)) : nextDateStr ? waitForFirestore().then(() => VacFacade.getByDate(nextDateStr, currentUser.branch)) : Promise.resolve([]);
    Promise.all([prevPromise, nextPromise]).then(([prevList, nextList]) => {
      if (cancelled) return;
      setAdjacentRecords({
        prev: prevList || [],
        next: nextList || []
      });
    }).catch(err => console.error("전날/다음날 조회 실패:", err));
    return () => {
      cancelled = true;
    };
  }, [selectedDate, isMidManager, isWideScreen, monthMap, currentUser.branch]);
  const dayRecords = selectedDate ? (monthMap[selectedDate] || []).filter(v => v.branch === currentUser.branch) : [];
  const sortedDayRecords = sortRecordsForDisplay(dayRecords);
  const activeRecordsForCapacity = dayRecords.filter(v => v.status !== "취소됨");
  const activeCount = activeRecordsForCapacity.length;
  const capacityCount = activeRecordsForCapacity.filter(v => isCapacityType(v.vacationType)).length;

  // 순번 수정 중인 값을 ref에 항상 최신으로 반영 (뒤로가기/닫기 시 자동 저장용)
  useEffect(() => {
    if (editingPriorityId) {
      const rec = dayRecords.find(v => v.id === editingPriorityId);
      editingPriorityRef.current = rec ? {
        record: rec,
        input: priorityInput
      } : null;
    } else {
      editingPriorityRef.current = null;
    }
  });
  const gyeongsanInfo = selectedDate ? (() => {
    const prevDayActive = (monthMap[prevDateStr] || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
    const capacity = gyeongsanCapacity(currentUser.branch, selectedDate, activeRecordsForCapacity, holidaySet, prevDayActive);
    const remain = capacity - capacityCount;
    return {
      capacity,
      remain,
      capacityCount
    };
  })() : null;

  // 야간 근무 신청 시 - 다음날이 이미 꽉 차서 비번 자리를 못 받는 경우를 미리 확인
  const isNightFormEntry = selectedDate && isNightShiftCode(formDia, currentUser.branch);
  const nightNextDayBlock = isNightFormEntry && nextDateStr && isCapacityType(formType) ? (() => {
    const nextDayActive = (monthMap[nextDateStr] || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
    // 비번을 먼저 신청해둔 경우 - 비번 자리는 이미 확보돼 있으니 다음날 정원 확인이 필요 없어요
    if (findCompatibleOffDutyRecord_(nextDayActive, currentUser.id, formType)) return false;
    const nextDayCapacityCount = nextDayActive.filter(v => isCapacityType(v.vacationType)).length;
    const nextDayCapacity = gyeongsanCapacity(currentUser.branch, nextDateStr, nextDayActive, holidaySet, [{
      dia: formDia,
      vacationType: formType
    }] // 지금 입력 중인 야간 신청 자체가 다음날 비번 자리를 열어주는 조건
    );
    return nextDayCapacityCount >= nextDayCapacity;
  })() : false;
  // 비번(~) DIA로 신청하면 전날 야간도 같이 자동 신청 (야간 먼저 신청할 때 다음날 비번이 자동으로 들어가는 것과 반대 방향)
  const offDutyNightDia = selectedDate && prevDateStr && NIGHT_COMPANION_TYPE_MAP[formType] ? offDutyDiaToNightDia_(formDia, currentUser.branch) : null;
  const handleSelfCancelClick = record => {
    const check = checkSelfCancelAllowed(currentUser.branch, record);
    if (!check.ok) {
      alert("⚠️ " + check.reason);
      return;
    }
    handleCancel(record);
  };
  const handleCancel = record => {
    if (!confirm(`${record.name}님의 ${record.vacationType} 기록을 취소할까요?`)) return;
    VacFacade.cancel(record.branch, record.date, record.id).then(() => {
      // 모달 내 목록에 즉시 "취소됨" 표시 (순번 재정렬 전, 빠른 화면 반응용)
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = (next[selectedDate] || []).map(v => v.id === record.id ? {
          ...v,
          status: "취소됨"
        } : v);
        return next;
      });
      // 야간/비번 짝이 있으면 반대쪽도 같이 취소돼요 - 짝이 있는 그 날짜만 콕 집어서 화면에 반영해요
      // (예전엔 여기서 달 전체를 다시 읽어왔는데, 짝 기록 하나 상태 바꾸는 데 그럴 필요가 없어요)
      // 야간 쪽이 짝으로 같이 취소되면, 그날 순번에도 구멍이 생기니 그 날짜도 같이 순번 정리해요
      // (아래 record.date 쪽 정리는 "직접 취소한 기록"의 날짜만 커버해서, 비번을 먼저 취소해
      //  야간이 연쇄로 취소되는 경우엔 이게 없으면 야간 쪽 날짜 순번이 안 정리됐어요)
      cancelNightPairIfAny(record, pairRecord => {
        setMonthMap(prev => {
          const next = {
            ...prev
          };
          const pairDate = pairRecord.date;
          next[pairDate] = (next[pairDate] || []).map(v => v.id === pairRecord.id ? {
            ...v,
            status: "취소됨"
          } : v);
          return next;
        });
        if (isCapacityType(pairRecord.vacationType)) {
          renumberDayPriorities_(pairRecord.date, pairRecord.branch, freshRecords => {
            setMonthMap(prev => ({
              ...prev,
              [pairRecord.date]: freshRecords
            }));
          });
        }
      });
      // 보장휴가면 그날 순번을 다시 매겨야 해요 - renumberDayPriorities_가 그 날짜 기록만
      // 다시 읽어와서 monthMap에 반영해줘요 (역시 달 전체를 다시 읽을 필요 없음)
      if (isCapacityType(record.vacationType)) {
        renumberDayPriorities_(record.date || selectedDate, record.branch, freshRecords => {
          setMonthMap(prev => ({
            ...prev,
            [record.date || selectedDate]: freshRecords
          }));
        });
      }
    });
  };

  // 짝수달 1일 선착순 신청 순번 수정 (본인이 그날 신청한 기록만, 그날 하루만 가능)
  const handleStartPriorityEdit = record => {
    setEditingPriorityId(record.id);
    setPriorityInput(String(record.priority != null ? record.priority : ""));
  };
  const handleSavePriorityEdit = record => {
    const num = parseInt(priorityInput, 10);
    if (Number.isNaN(num) || num < 1) {
      alert("1 이상의 숫자를 입력해주세요");
      return;
    }
    reorderDayPriority_(record, num, (fresh, pos) => {
      setMonthMap(prev => ({
        ...prev,
        [record.date]: fresh
      }));
      if (pos !== num) alert(`전체 ${pos}명이라 ${pos}번(맨 끝)으로 맞췄어요.`);
    }).then(() => {
      setEditingPriorityId(null);
    }).catch(err => alert("수정 실패: " + (err && err.message ? err.message : err)));
  };

  // 이미 등록된 기록에 나중에 비고(메모)를 추가/수정 - 운용(중간관리자)만
  const handleStartNoteEdit = record => {
    setEditingNoteId(record.id);
    setNoteInput(record.note || "");
  };
  const handleSaveNoteEdit = record => {
    const trimmed = noteInput.trim();
    VacFacade.update(record.branch, record.date, record.id, {
      note: trimmed
    }).then(() => {
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = (next[selectedDate] || []).map(v => v.id === record.id ? {
          ...v,
          note: trimmed
        } : v);
        return next;
      });
      setEditingNoteId(null);
    }).catch(err => alert("메모 저장 실패: " + (err && err.message ? err.message : err)));
  };

  // 삭제/취소 등으로 생긴 순번 구멍 정리 - 공용 함수를 불러다 쓰고, 화면(monthMap) 갱신만 여기서 해요
  const renumberDayPriorities = (dateStr, branch) => {
    renumberDayPriorities_(dateStr, branch, freshRecords => {
      setMonthMap(prev => ({
        ...prev,
        [dateStr]: freshRecords
      }));
    });
  };
  const handleAdminDelete = record => {
    if (!confirm(`[관리자] ${record.name}님의 ${record.vacationType} 기록을 완전히 삭제할까요?\n되돌릴 수 없어요.`)) return;
    VacFacade.remove(record.branch, record.date, record.id).then(() => {
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = (next[selectedDate] || []).filter(v => v.id !== record.id);
        return next;
      });
      renumberDayPriorities(selectedDate, record.branch);
    });
  };
  const submitVacationRecord = (priority, capacityGuard, existingOffDuty) => {
    const docId = `${currentUser.id}_${selectedDate}`; // 직원ID_날짜 고정 ID - 중복 신청 원천 차단
    const companionType = NIGHT_COMPANION_TYPE_MAP[formType];
    const shouldAddCompanion = isNightFormEntry && companionType && nextDateStr;
    const companionDocId = shouldAddCompanion ? existingOffDuty ? existingOffDuty.id : `${currentUser.id}_${nextDateStr}` : null;
    const savedDia = normalizeSInput_(currentUser.branch, selectedDate, formDia, holidaySet);
    let companionSaved = false;
    VacFacade.addOnce(currentUser.branch, selectedDate, currentUser.id, {
      name: currentUser.name,
      branch: currentUser.branch,
      employeeId: currentUser.id,
      vacationType: formType,
      dia: savedDia,
      date: selectedDate,
      ...(priority != null ? {
        priority
      } : {})
    }, capacityGuard).then(() => {
      if (!shouldAddCompanion) return;
      if (existingOffDuty) {
        // 비번을 먼저 신청해둔 경우 - 새로 만들지 않고 그 기록을 비번 짝(연차비 등)으로 바꿔서 연결해요.
        // (순번·신청시각은 그대로 유지, 종류·DIA만 짝 규칙에 맞춰요 → 야간 취소 시 같이 취소되고 사용개수도 안 겹쳐요)
        return VacFacade.update(currentUser.branch, nextDateStr, existingOffDuty.id, {
          vacationType: companionType,
          dia: nightDiaToOffDutyDia(savedDia)
        }).then(() => {
          companionSaved = true;
        }).catch(err => {
          console.error("비번 연결 실패:", err);
          alert("야간 휴가는 저장됐지만, 먼저 신청한 다음날 비번과 연결하지 못했어요. 운용에 확인을 요청해주세요.");
        });
      }
      // 야간 신청이면 다음날 "비번" 기록도 같이 자동 등록해요 (연차→연차비, 분지→분지비, 장재→장재비)
      return VacFacade.addOnce(currentUser.branch, nextDateStr, currentUser.id, {
        name: currentUser.name,
        branch: currentUser.branch,
        employeeId: currentUser.id,
        vacationType: companionType,
        dia: nightDiaToOffDutyDia(savedDia),
        date: nextDateStr
      }).then(() => {
        companionSaved = true;
      }).catch(err => {
        console.error("비번 자동 등록 실패:", err);
        alert("휴가는 저장됐지만, 다음날 비번 자동 등록에 실패했어요. 다음날에 직접 비번을 추가로 입력해주세요.");
      });
    }).then(() => {
      setShowRegisterForm(false);
      setFormDia("");
      // 방금 저장한 기록(+성공한 경우 짝 비번)만 화면에 콕 집어 반영해요 - 달 전체를 다시 읽지 않아요
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = [...(next[selectedDate] || []), {
          id: docId,
          name: currentUser.name,
          branch: currentUser.branch,
          employeeId: currentUser.id,
          vacationType: formType,
          dia: savedDia,
          date: selectedDate,
          status: "정상",
          ...(priority != null ? {
            priority
          } : {})
        }];
        if (companionSaved && existingOffDuty) {
          next[nextDateStr] = (next[nextDateStr] || []).map(v => v.id === existingOffDuty.id ? {
            ...v,
            vacationType: companionType,
            dia: nightDiaToOffDutyDia(savedDia)
          } : v);
        } else if (companionSaved) {
          next[nextDateStr] = [...(next[nextDateStr] || []), {
            id: companionDocId,
            name: currentUser.name,
            branch: currentUser.branch,
            employeeId: currentUser.id,
            vacationType: companionType,
            dia: nightDiaToOffDutyDia(savedDia),
            date: nextDateStr,
            status: "정상"
          }];
        }
        return next;
      });
    }).catch(err => {
      console.error(err);
      if (err && err.message === "CAPACITY_FULL") {
        alert(`앗, 저장하는 순간 보장인원(${err.capacity}명)이 다 찼어요. 다른 날짜를 선택해주세요.`);
        loadMonth(viewYear, viewMonth);
        setShowRegisterForm(false);
        return;
      }
      if (err && err.message === "DUPLICATE_ENTRY") {
        alert("이미 이 날짜에 신청하신 기록이 있어요. 화면을 새로고침할게요.");
        loadMonth(viewYear, viewMonth);
        setShowRegisterForm(false);
        return;
      }
      alert("등록에 실패했어요: " + (err && err.message ? err.message : err));
    }).finally(() => setSaving(false));
  };
  // 비번 먼저 신청 → 전날 야간 + 오늘 비번(연차비 등)을 한 번에 저장해요. 두 날짜 정원을 모두 확인하고,
  // 비번 저장이 실패하면 방금 넣은 야간도 되돌려서 반쪽만 남지 않게 해요.
  const handleSubmitOffDutyFirst = () => {
    const branch = currentUser.branch;
    const nightDate = prevDateStr;
    const nightPrevDate = shiftDateStr_(nightDate, -1);
    const companionType = NIGHT_COMPANION_TYPE_MAP[formType];
    const capType = isCapacityType(formType);
    const nightDia = normalizeSInput_(branch, nightDate, offDutyNightDia, holidaySet);
    const offDia = String(formDia || "").trim();
    const activeOf = list => (list || []).filter(v => v.branch === branch && v.status !== "취소됨");
    const fail = msg => {
      alert(msg);
      loadMonth(viewYear, viewMonth);
      setShowRegisterForm(false);
    };
    setSaving(true);
    waitForFirestore().then(() => Promise.all([VacFacade.getByDate(selectedDate, branch), VacFacade.getByDate(nightDate, branch), VacFacade.getByDate(nightPrevDate, branch)])).then(([dayRecs, nightRecs, nightPrevRecs]) => {
      const dayActive = activeOf(dayRecs);
      const nightActive = activeOf(nightRecs);
      const nightPrevActive = activeOf(nightPrevRecs);
      if (dayActive.some(v => v.employeeId === currentUser.id)) return fail("이미 이 날짜에 신청하신 기록이 있어요. 화면을 새로고침할게요.");
      if (nightActive.some(v => v.employeeId === currentUser.id)) return fail(`전날(${nightDate})에 이미 본인 기록이 있어서 야간을 자동으로 넣을 수 없어요. 전날 기록을 먼저 확인해주세요.`);
      const makeErr = (code, cap) => {
        const e = new Error(code);
        e.capacity = cap;
        return e;
      };
      // 전날(야간) 정원 - 전전날 야간 여부까지 반영
      const nightGuard = list => {
        if (!capType) return;
        const act = activeOf(list);
        const cnt = act.filter(v => isCapacityType(v.vacationType)).length;
        const cap = gyeongsanCapacity(branch, nightDate, act, holidaySet, nightPrevActive);
        if (cnt >= cap) throw makeErr("CAPACITY_FULL_NIGHT", cap);
      };
      // 오늘(비번) 정원 - 방금 넣을 야간이 비번 자리를 열어주는 조건으로 계산
      const nightAsPrev = [...nightActive, {
        dia: nightDia,
        vacationType: formType
      }];
      const offGuard = list => {
        if (!capType) return;
        const act = activeOf(list);
        const cnt = act.filter(v => isCapacityType(v.vacationType)).length;
        const cap = gyeongsanCapacity(branch, selectedDate, act, holidaySet, nightAsPrev);
        if (cnt >= cap) throw makeErr("CAPACITY_FULL_OFF", cap);
      };
      nightGuard(nightRecs); // 미리 확인 (실패하면 아래 catch로)
      offGuard(dayRecs);
      const nightPriority = capType ? (nightRecs || []).filter(v => v.branch === branch && isCapacityType(v.vacationType)).length + 1 : null;
      const base = {
        name: currentUser.name,
        branch,
        employeeId: currentUser.id
      };
      const nightRecord = {
        ...base,
        vacationType: formType,
        dia: nightDia,
        date: nightDate,
        ...(nightPriority != null ? {
          priority: nightPriority
        } : {})
      };
      const offRecord = {
        ...base,
        vacationType: companionType,
        dia: offDia,
        date: selectedDate
      };
      return VacFacade.addOnce(branch, nightDate, currentUser.id, nightRecord, nightGuard).then(() => VacFacade.addOnce(branch, selectedDate, currentUser.id, offRecord, offGuard).catch(err => {
        // 비번 저장 실패 → 방금 넣은 야간도 지워서 되돌려요
        return VacFacade.remove(branch, nightDate, `${currentUser.id}_${nightDate}`).catch(e2 => console.error("야간 되돌리기 실패:", e2)).then(() => {
          throw err;
        });
      })).then(() => {
        setShowRegisterForm(false);
        setFormDia("");
        setMonthMap(prev => ({
          ...prev,
          [nightDate]: [...(prev[nightDate] || []), {
            id: `${currentUser.id}_${nightDate}`,
            ...nightRecord,
            status: "정상"
          }],
          [selectedDate]: [...(prev[selectedDate] || []), {
            id: `${currentUser.id}_${selectedDate}`,
            ...offRecord,
            status: "정상"
          }]
        }));
        alert(`전날(${nightDate}) 야간 ${nightDia}와 오늘 비번 ${offDia}가 같이 신청됐어요.`);
      });
    }).catch(err => {
      console.error(err);
      const code = err && err.message;
      if (code === "CAPACITY_FULL_NIGHT") return fail(`전날(${nightDate}) 보장인원(${err.capacity}명)이 다 차서 야간을 같이 신청할 수 없어요. 비번만 따로 신청할 수 없으니 다른 날짜를 선택해주세요.`);
      if (code === "CAPACITY_FULL_OFF") return fail(`이 날짜 보장인원(${err.capacity}명)이 다 차서 신청할 수 없어요.`);
      if (code === "DUPLICATE_ENTRY") return fail("이미 신청하신 기록이 있어요. 화면을 새로고침할게요.");
      alert("등록에 실패했어요: " + (code || err));
    }).finally(() => setSaving(false));
  };
  const handleSubmitRegister = () => {
    if (offDutyNightDia) return handleSubmitOffDutyFirst();
    setSaving(true);
    // 저장 시점에 그날의 최신 데이터로 중복신청 여부와 보장인원 정원을 다시 확인해요
    // (동시 신청으로 인한 중복/초과 방지).
    waitForFirestore().then(() => Promise.all([VacFacade.getByDate(selectedDate, currentUser.branch), prevDateStr ? VacFacade.getByDate(prevDateStr, currentUser.branch) : Promise.resolve([]), isNightFormEntry && nextDateStr ? VacFacade.getByDate(nextDateStr, currentUser.branch) : Promise.resolve([])])).then(([freshDayRecords, prevDayRecords, nextDayRecords]) => {
      const freshActive = (freshDayRecords || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
      const prevDayActive = (prevDayRecords || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
      const alreadyMine = freshActive.some(v => v.employeeId === currentUser.id);
      if (alreadyMine) {
        setSaving(false);
        alert("이미 이 날짜에 신청하신 기록이 있어요. 화면을 새로고침할게요.");
        loadMonth(viewYear, viewMonth);
        setShowRegisterForm(false);
        return;
      }
      const freshCapacityCount = freshActive.filter(v => isCapacityType(v.vacationType)).length;
      const capacity = gyeongsanCapacity(currentUser.branch, selectedDate, freshActive, holidaySet, prevDayActive);
      if (freshCapacityCount >= capacity) {
        setSaving(false);
        alert(`앗, 방금 다른 분이 신청해서 이 날짜의 보장인원(${capacity}명)이 다 찼어요. 다른 날짜를 선택해주세요.`);
        loadMonth(viewYear, viewMonth); // 화면도 최신 상태로 갱신
        setShowRegisterForm(false);
        return;
      }

      // 야간 근무면 다음날 상황도 최신 데이터로 재확인해요
      let existingOffDuty = null; // 비번을 먼저 신청해둔 기록 (있으면 새로 만들지 않고 짝으로 연결)
      if (isNightFormEntry && nextDateStr) {
        const nextDayActive = (nextDayRecords || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
        existingOffDuty = findCompatibleOffDutyRecord_(nextDayActive, currentUser.id, formType);
        // 보장인원 포함 종류(연차/분지/장재)만 다음날 자리(정원) 확인이 필요해요.
        // 청휴비/병가비 같은 미포함 짝은 자리를 안 차지하니 이 확인 자체가 필요 없어요.
        // 비번을 먼저 신청해둔 경우도 자리가 이미 확보돼 있어서 확인이 필요 없어요.
        if (isCapacityType(formType) && !existingOffDuty) {
          const nextDayCapacityCount = nextDayActive.filter(v => isCapacityType(v.vacationType)).length;
          const nextDayCapacity = gyeongsanCapacity(currentUser.branch, nextDateStr, nextDayActive, holidaySet, [{
            dia: formDia,
            vacationType: formType
          }]);
          if (nextDayCapacityCount >= nextDayCapacity) {
            setSaving(false);
            alert(`앗, 다음날(${nextDateStr})이 이미 다 차서 야간 신청을 저장할 수 없어요. 다른 날짜를 선택해주세요.`);
            loadMonth(viewYear, viewMonth);
            setShowRegisterForm(false);
            return;
          }
        }
        // 다음날에 본인이 이미 다른 기록을 갖고 있으면, 비번 자동등록이 그 기록을 덮어쓸 수 있어 미리 막아요
        // (종류(capacity 여부)와 무관하게 항상 확인해야 해요)
        if (NIGHT_COMPANION_TYPE_MAP[formType] && !existingOffDuty && nextDayActive.some(v => v.employeeId === currentUser.id)) {
          setSaving(false);
          alert(`다음날(${nextDateStr})에 이미 본인 기록이 있는데, 이 야간의 비번(DIA가 ~로 끝나는 같은 종류 휴가)이 아니라서 연결할 수 없어요. 다음날 기록을 먼저 확인해주세요.`);
          loadMonth(viewYear, viewMonth);
          setShowRegisterForm(false);
          return;
        }
      }

      // 순번(짝수달 1일 선착순 신청용) - 그 날짜 보장휴가 기록 수(취소 포함) 다음 번호로 자동 부여
      const priorityBase = (freshDayRecords || []).filter(v => v.branch === currentUser.branch && isCapacityType(v.vacationType)).length;
      const nextPriority = isCapacityType(formType) ? priorityBase + 1 : null;
      // 트랜잭션 안에서 한 번 더 정원을 확인하는 검사 함수 - 위의 확인과 저장 사이에
      // 다른 사람이 끼어들어도 여기서 막혀요
      const capacityGuard = latestEntries => {
        const act = latestEntries.filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
        const cnt = act.filter(v => isCapacityType(v.vacationType)).length;
        const cap = gyeongsanCapacity(currentUser.branch, selectedDate, act, holidaySet, prevDayActive);
        if (cnt >= cap) {
          const e = new Error("CAPACITY_FULL");
          e.capacity = cap;
          throw e;
        }
      };
      submitVacationRecord(nextPriority, capacityGuard, existingOffDuty);
    }).catch(err => {
      console.error(err);
      setSaving(false);
      alert("확인 중 오류가 발생했어요: " + (err && err.message ? err.message : err));
    });
  };

  // 중간관리자 확인 도장
  const handleConfirmStamp = (record, managerName) => {
    VacFacade.confirm(record.branch, record.date, record.id, managerName).then(() => {
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = (next[selectedDate] || []).map(v => v.id === record.id ? {
          ...v,
          confirmedBy: managerName
        } : v);
        return next;
      });
      // 야간/비번 짝이 있으면 반대쪽도 같이 확인 처리 - 짝이 있는 그 날짜만 콕 집어 반영해요
      confirmNightPairIfAny(record, managerName, pairRecord => {
        setMonthMap(prev => {
          const next = {
            ...prev
          };
          const pairDate = pairRecord.date;
          next[pairDate] = (next[pairDate] || []).map(v => v.id === pairRecord.id ? {
            ...v,
            confirmedBy: managerName
          } : v);
          return next;
        });
      });
    });
  };

  // 실수로 확인 처리한 기록을 다시 "대기중"으로 되돌려요 - 야간/비번 짝이 있고 그 짝도 확인된
  // 상태면, 짝도 같이 대기중으로 되돌려요 (확인 처리할 때 짝도 같이 확인되는 것과 대칭이에요).
  const handleUnconfirm = record => {
    if (!confirm(`${record.name}님의 ${record.vacationType} 확인을 취소하고 대기중으로 되돌릴까요?`)) return;
    VacFacade.update(record.branch, record.date, record.id, {
      confirmedBy: null,
      confirmedAt: null
    }).then(() => {
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = (next[selectedDate] || []).map(v => v.id === record.id ? {
          ...v,
          confirmedBy: null
        } : v);
        return next;
      });
      findNightPair(record).then(pairRecord => {
        if (!pairRecord || !pairRecord.confirmedBy) return;
        VacFacade.update(pairRecord.branch, pairRecord.date, pairRecord.id, {
          confirmedBy: null,
          confirmedAt: null
        }).then(() => {
          setMonthMap(prev => {
            const next = {
              ...prev
            };
            const pairDate = pairRecord.date;
            next[pairDate] = (next[pairDate] || []).map(v => v.id === pairRecord.id ? {
              ...v,
              confirmedBy: null
            } : v);
            return next;
          });
        });
      });
    });
  };

  // 중간관리자 - 대신 기록 폼 열기
  const openManagerForm = () => {
    setManagerTargetId("");
    setManagerFormType(NON_CAPACITY_TYPES[0]);
    setManagerFormDia("");
    setManagerFormNote("");
    setManagerFormOtherReason("");
    setManagerFormUnassigned(false);
    setShowManagerForm(true);
  };
  const branchAllEmployees = employees.filter(e => e.branch === currentUser.branch);
  const handleSubmitManagerRecord = () => {
    const target = branchAllEmployees.find(e => e.id === managerTargetId);

    // 대상자를 지정하는 경우에만 대상자 선택 확인
    if (!managerFormUnassigned && !target) {
      alert("대상자를 선택해주세요");
      return;
    }

    // 대상자 미정이면 DIA도 미지정으로 자동 처리
    // 대상자가 지정된 경우에는 DIA 선택 필수
    if (!managerFormUnassigned && !managerFormDia.trim()) {
      alert("DIA를 입력해주세요");
      return;
    }
    if (managerFormType === "기타" && !managerFormOtherReason.trim()) {
      alert("기타 사유를 입력해주세요");
      return;
    }
    const finalVacationType = managerFormType === "기타" ? `기타: ${managerFormOtherReason.trim()}` : managerFormType;

    // ★ 대상자 미정이면 이름과 DIA 모두 미지정
    const finalName = managerFormUnassigned ? "미지정" : target.name;
    const finalDia = managerFormUnassigned ? "미지정" : normalizeSInput_(currentUser.branch, selectedDate, managerFormDia, holidaySet);

    // 비번(~)으로 입력하면 전날 야간도 같이 기록해요 (본인 신청과 같은 규칙, 운용은 정원 확인 없음)
    const offNightDia = !managerFormUnassigned && NIGHT_COMPANION_TYPE_MAP[finalVacationType] && prevDateStr ? offDutyDiaToNightDia_(finalDia, currentUser.branch) : null;
    if (offNightDia) {
      const branch = currentUser.branch;
      const nightDate = prevDateStr;
      const nightDia = normalizeSInput_(branch, nightDate, offNightDia, holidaySet);
      const companionTypeOff = NIGHT_COMPANION_TYPE_MAP[finalVacationType];
      setManagerSaving(true);
      VacFacade.getByDate(nightDate, branch).then(nightRecs => {
        const nightActive = (nightRecs || []).filter(v => v.branch === branch && v.status !== "취소됨");
        if (nightActive.some(v => v.employeeId === target.id)) {
          alert(`${target.name}님은 전날(${nightDate})에 이미 기록이 있어서 야간을 자동으로 넣을 수 없어요. 전날 기록을 먼저 확인해주세요.`);
          return;
        }
        const nightPriority = isCapacityType(finalVacationType) ? (nightRecs || []).filter(v => v.branch === branch && isCapacityType(v.vacationType)).length + 1 : null;
        const common = {
          name: target.name,
          branch,
          employeeId: target.id,
          recordedBy: currentUser.name
        };
        const nightRecord = {
          ...common,
          vacationType: finalVacationType,
          dia: nightDia,
          date: nightDate,
          ...(nightPriority != null ? {
            priority: nightPriority
          } : {}),
          ...(managerFormNote.trim() ? {
            note: managerFormNote.trim()
          } : {})
        };
        const offRecord = {
          ...common,
          vacationType: companionTypeOff,
          dia: finalDia,
          date: selectedDate
        };
        return VacFacade.add(branch, nightDate, nightRecord).then(nightId => VacFacade.add(branch, selectedDate, offRecord).catch(err => {
          // 비번 저장 실패 → 방금 넣은 야간도 지워서 되돌려요
          return VacFacade.remove(branch, nightDate, nightId).catch(e2 => console.error("야간 되돌리기 실패:", e2)).then(() => {
            throw err;
          });
        }).then(offId => {
          setShowManagerForm(false);
          setMonthMap(prev => ({
            ...prev,
            [nightDate]: [...(prev[nightDate] || []), {
              id: nightId,
              ...nightRecord,
              status: "정상"
            }],
            [selectedDate]: [...(prev[selectedDate] || []), {
              id: offId,
              ...offRecord,
              status: "정상"
            }]
          }));
          alert(`${target.name}님 전날(${nightDate}) 야간 ${nightDia}와 비번 ${finalDia}를 같이 기록했어요.`);
        }));
      }).catch(err => {
        console.error(err);
        alert("등록에 실패했어요: " + (err && err.message ? err.message : err));
      }).finally(() => setManagerSaving(false));
      return;
    }
    setManagerSaving(true);

    // 본인 신청과 동일한 방식으로 순번을 자동 부여해요 - 그날 그 소속의 보장휴가 기록 수(취소 포함)
    // 다음 번호로. "대상자 미정"이나 보장인원 미포함 항목(기타 등)은 순번 자체가 필요 없어요.
    const assignPriority = () => {
      if (managerFormUnassigned || !isCapacityType(finalVacationType)) return Promise.resolve(null);
      return VacFacade.getByDate(selectedDate, currentUser.branch).then(dayRecords => {
        const count = (dayRecords || []).filter(v => isCapacityType(v.vacationType)).length;
        return count + 1;
      });
    };

    // 야간 근무면 다음날 "비번" 기록도 자동으로 같이 등록해요 (본인 신청과 동일한 규칙).
    // 대상자 미정인 경우엔 실제 DIA가 없어서 야간 판단 자체가 불가능하니 건너뛰어요.
    const companionType = NIGHT_COMPANION_TYPE_MAP[finalVacationType];
    const shouldAddCompanion = !managerFormUnassigned && companionType && nextDateStr && isNightShiftCode(finalDia, currentUser.branch);
    assignPriority().then(priority => {
      const newRecord = {
        name: finalName,
        branch: currentUser.branch,
        employeeId: managerFormUnassigned ? "" : target.id,
        vacationType: finalVacationType,
        // ★ 대상자 미정이면 미지정
        dia: finalDia,
        date: selectedDate,
        recordedBy: currentUser.name,
        ...(priority != null ? {
          priority
        } : {}),
        ...(managerFormUnassigned ? {
          unassigned: true
        } : {}),
        ...(managerFormNote.trim() ? {
          note: managerFormNote.trim()
        } : {})
      };
      return VacFacade.add(currentUser.branch, selectedDate, newRecord).then(id => ({
        id,
        ...newRecord
      }));
    }).then(savedRecord => {
      if (!shouldAddCompanion) return {
        savedRecord,
        companionRecord: null
      };
      const companionRecord = {
        name: finalName,
        branch: currentUser.branch,
        employeeId: target.id,
        vacationType: companionType,
        dia: nightDiaToOffDutyDia(finalDia),
        date: nextDateStr,
        recordedBy: currentUser.name
      };
      return VacFacade.getByDate(nextDateStr, currentUser.branch).then(nextRecs => {
        const nextActive = (nextRecs || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
        // 대상자가 다음날 비번을 이미 갖고 있으면 새로 만들지 않고 짝으로 연결해요 (중복 방지)
        const existing = findCompatibleOffDutyRecord_(nextActive, target.id, finalVacationType);
        if (existing) {
          const patch = {
            vacationType: companionType,
            dia: nightDiaToOffDutyDia(finalDia)
          };
          return VacFacade.update(currentUser.branch, nextDateStr, existing.id, patch).then(() => ({
            savedRecord,
            companionRecord: {
              ...existing,
              ...patch
            },
            companionLinked: true
          }));
        }
        if (nextActive.some(v => v.employeeId === target.id)) {
          alert(`기록은 저장됐어요. 다만 ${target.name}님은 다음날(${nextDateStr})에 이미 다른 기록이 있어서 비번은 자동으로 넣지 않았어요.`);
          return {
            savedRecord,
            companionRecord: null
          };
        }
        return VacFacade.add(currentUser.branch, nextDateStr, companionRecord).then(id => ({
          savedRecord,
          companionRecord: {
            id,
            ...companionRecord
          }
        }));
      }).catch(err => {
        console.error("비번 자동 등록 실패:", err);
        alert("기록은 저장됐지만, 다음날 비번 자동 등록에 실패했어요. 다음날에 직접 비번을 추가로 입력해주세요.");
        return {
          savedRecord,
          companionRecord: null
        };
      });
    }).then(({
      savedRecord,
      companionRecord,
      companionLinked
    }) => {
      setShowManagerForm(false);
      // 방금 등록한 기록(+성공한 경우 짝 비번)만 화면에 콕 집어 반영해요 - 달 전체를 다시 읽지 않아요
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        next[selectedDate] = [...(next[selectedDate] || []), {
          ...savedRecord,
          status: "정상"
        }];
        if (companionRecord && companionLinked) {
          next[nextDateStr] = (next[nextDateStr] || []).map(v => v.id === companionRecord.id ? {
            ...v,
            ...companionRecord
          } : v);
        } else if (companionRecord) {
          next[nextDateStr] = [...(next[nextDateStr] || []), {
            ...companionRecord,
            status: "정상"
          }];
        }
        return next;
      });
    }).catch(err => {
      console.error(err);
      alert("등록에 실패했어요: " + (err && err.message ? err.message : err));
    }).finally(() => {
      setManagerSaving(false);
    });
  };
  // "대상자 미정"으로 먼저 등록해둔 기록에, 나중에 실제 사람+DIA를 같이 배정해요.
  // employeeId는 보안규칙상 수정이 안 돼서, 기존 기록을 지우고 그 내용 그대로 새로 등록하는 방식이에요.
  const [assigningRecordId, setAssigningRecordId] = useState(null);
  const [assignPersonId, setAssignPersonId] = useState("");
  const [assignDia, setAssignDia] = useState("");

  // 선택한 직원의 그 날짜 원래(평소) 교번을 자동으로 계산 - DIA 기본값 채워주기용
  const codeForEmployeeOnDate = (empId, dateStr) => {
    const emp = branchAllEmployees.find(e => e.id === empId);
    const teamKey = REVERSE_TEAM_MAP[currentUser.branch];
    const order = GYOBUN_ORDER[teamKey] || [];
    if (!emp || !BASE_DATE || !order.length) return "";
    const bc = baseCodeForPersonOnDate_(employees, emp.name, emp.branch, dateStr, emp.baseCode);
    if (!bc) return "";
    const offset = diffDays_(BASE_DATE, dateStr);
    return shiftCodeByDays_(order, bc, offset);
  };
  const startAssigning = record => {
    setAssigningRecordId(record.id);
    setAssignPersonId("");
    setAssignDia("");
  };
  const handleAssignPersonSelect = (record, personId) => {
    setAssignPersonId(personId);
    // 사람을 고르면, 그 사람의 그날 원래 교번을 DIA 기본값으로 자동으로 채워줘요 (원하면 아래에서 바꿀 수 있어요)
    const autoDia = personId ? codeForEmployeeOnDate(personId, record.date) : "";
    setAssignDia(autoDia || "");
  };
  const handleConfirmAssign = record => {
    const target = branchAllEmployees.find(e => e.id === assignPersonId);
    if (!target) {
      alert("사람을 선택해주세요");
      return;
    }
    if (!assignDia.trim()) {
      alert("DIA를 선택해주세요");
      return;
    }
    if (!confirm(`${target.name}님 / ${assignDia}(으)로 배정할까요?`)) return;
    VacFacade.remove(record.branch, record.date, record.id).then(() => {
      const newRecord = {
        name: target.name,
        branch: currentUser.branch,
        employeeId: target.id,
        vacationType: record.vacationType,
        dia: assignDia.trim(),
        date: record.date,
        recordedBy: currentUser.name,
        ...(record.note ? {
          note: record.note
        } : {})
      };
      return VacFacade.add(currentUser.branch, record.date, newRecord).then(id => ({
        id,
        ...newRecord
      }));
    }).then(savedRecord => {
      setAssigningRecordId(null);
      setAssignPersonId("");
      setAssignDia("");
      // 지운 "미지정" 기록을 새로 배정된 기록으로 콕 집어 교체해요 - 달 전체를 다시 읽지 않아요
      setMonthMap(prev => {
        const next = {
          ...prev
        };
        const dateKey = savedRecord.date;
        next[dateKey] = (next[dateKey] || []).filter(v => v.id !== record.id).concat({
          ...savedRecord,
          status: "정상"
        });
        return next;
      });
    }).catch(err => {
      console.error(err);
      alert("배정에 실패했어요: " + (err && err.message ? err.message : err));
    });
  };
  const touchStartX = useRef(null);
  const dayTouchStartX = useRef(null); // 날짜 상세 모달 스와이프용
  const dayGridRef = useRef(null);
  const [daySlideX, setDaySlideX] = useState(0);
  const [daySlideTransition, setDaySlideTransition] = useState(false);
  const gridRef = useRef(null);
  const [slideX, setSlideX] = useState(0);
  const [slideTransition, setSlideTransition] = useState(false);
  const handleTouchStart = e => {
    touchStartX.current = e.touches[0].clientX;
    setSlideTransition(false);
  };
  const handleTouchMove = e => {
    if (touchStartX.current == null) return;
    setSlideX(e.touches[0].clientX - touchStartX.current);
  };
  const handleTouchEnd = () => {
    if (touchStartX.current == null) return;
    const dx = slideX;
    touchStartX.current = null;
    const width = gridRef.current ? gridRef.current.offsetWidth : 320;
    if (Math.abs(dx) > 60) {
      const dir = dx < 0 ? 1 : -1; // dir 1 = 다음달(왼쪽으로 스와이프), -1 = 이전달
      setSlideTransition(true);
      setSlideX(-dir * width); // 현재 페이지가 화면 밖으로 완전히 빠져나감
      setTimeout(() => {
        changeMonth(dir);
        setSlideTransition(false);
        setSlideX(dir * width); // 다음 페이지를 반대편 화면 밖에 미리 배치
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setSlideTransition(true);
            setSlideX(0); // 화면 안으로 슬라이드 인
          });
        });
      }, 220);
    } else {
      setSlideTransition(true);
      setSlideX(0);
    }
  };

  // 날짜 상세 모달 스와이프 - 월 달력과 같은 방식의 슬라이드 애니메이션
  const handleDayTouchStart = e => {
    dayTouchStartX.current = e.touches[0].clientX;
    setDaySlideTransition(false);
  };
  const handleDayTouchMove = e => {
    if (dayTouchStartX.current == null) return;
    if (showManagerForm || showRegisterForm) return; // 폼 작성 중엔 드래그 무시
    setDaySlideX(e.touches[0].clientX - dayTouchStartX.current);
  };
  const handleDayTouchEnd = () => {
    if (dayTouchStartX.current == null) return;
    dayTouchStartX.current = null;
    if (showManagerForm || showRegisterForm) {
      setDaySlideX(0);
      return;
    }
    const dx = daySlideX;
    const width = dayGridRef.current ? dayGridRef.current.offsetWidth : 320;
    if (Math.abs(dx) > 60) {
      const dir = dx < 0 ? 1 : -1; // dir 1 = 다음날(왼쪽으로 스와이프), -1 = 이전날
      setDaySlideTransition(true);
      setDaySlideX(-dir * width);
      setTimeout(() => {
        changeDay(dir);
        setDaySlideTransition(false);
        setDaySlideX(dir * width);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setDaySlideTransition(true);
            setDaySlideX(0);
          });
        });
      }, 220);
    } else {
      setDaySlideTransition(true);
      setDaySlideX(0);
    }
  };

  // 운용 전용 - 전날/다음날 요약 칸 (읽기 전용, 간략하게)
  const renderCompactDayColumn = (dateStr, records, label) => {
    const branchRecords = sortRecordsForDisplay(records);
    const activeRecs = branchRecords.filter(v => v.status !== "취소됨");
    const capacityActive = activeRecs.filter(v => isCapacityType(v.vacationType));
    const colPrevDate = new Date(dateStr + "T00:00:00");
    colPrevDate.setDate(colPrevDate.getDate() - 1);
    const colPrevKey = `${colPrevDate.getFullYear()}-${pad2(colPrevDate.getMonth() + 1)}-${pad2(colPrevDate.getDate())}`;
    const colPrevActive = (monthMap[colPrevKey] || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
    const capacity = gyeongsanCapacity(currentUser.branch, dateStr, activeRecs, holidaySet, colPrevActive);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        flex: "3 3 0",
        minWidth: 0,
        background: "#fff",
        border: "1px solid #eee",
        borderRadius: "10px",
        padding: "14px",
        height: "63vh",
        overflowY: "auto",
        boxSizing: "border-box"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: "64px",
        boxSizing: "border-box"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        fontWeight: 700,
        color: "#888",
        marginBottom: "2px"
      }
    }, label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "15px",
        fontWeight: 700,
        marginBottom: "2px",
        lineHeight: "22px",
        color: dateHeaderColor(dateStr, holidaySet)
      }
    }, dateStr, " (", weekdayShort(dateStr), ")"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "#666"
      }
    }, "휴가자 ", activeRecs.length, "명 · 보장대상 ", capacityActive.length, "/", capacity, "명")), branchRecords.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: "#aaa",
        padding: "16px 0",
        fontSize: "12px"
      }
    }, "등록된 휴가가 없어요") : /*#__PURE__*/React.createElement("table", {
      style: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "12px"
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
      style: {
        borderBottom: "2px solid #333"
      }
    }, /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        fontSize: "11px",
        padding: "5px 3px"
      }
    }, "#"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left",
        fontSize: "11px",
        padding: "5px 3px"
      }
    }, "이름"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left",
        fontSize: "11px",
        padding: "5px 3px"
      }
    }, "휴가명"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        fontSize: "11px",
        padding: "5px 3px"
      }
    }, "DIA"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left",
        fontSize: "11px",
        padding: "5px 3px"
      }
    }, "확인"))), /*#__PURE__*/React.createElement("tbody", null, branchRecords.map((v, idx) => {
      const cancelled = v.status === "취소됨";
      const cap = isCapacityType(v.vacationType);
      const prevCap = idx > 0 ? isCapacityType(branchRecords[idx - 1].vacationType) : null;
      const showGroupHeader = idx === 0 || cap !== prevCap;
      return /*#__PURE__*/React.createElement(React.Fragment, {
        key: v.id
      }, showGroupHeader && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
        colSpan: 5,
        style: {
          padding: "6px 3px 4px",
          fontSize: "13px",
          fontWeight: 800,
          color: cap ? "#1b3a5c" : "#666",
          background: cap ? "#eaf1ff" : "#f2f2f2"
        }
      }, cap ? "🟢 보장인원 포함" : "⚪ 보장인원 미포함")), /*#__PURE__*/React.createElement("tr", {
        style: {
          borderBottom: "1px solid #eee",
          opacity: cancelled ? 0.45 : 1,
          textDecoration: cancelled ? "line-through" : "none"
        }
      }, /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          padding: "6px 3px"
        }
      }, v.priority != null ? v.priority : idx + 1), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left",
          padding: "6px 3px"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: v.unassigned ? "#e08a20" : undefined,
          fontWeight: v.unassigned ? 700 : undefined
        }
      }, v.unassigned ? "🔔" : TYPE_ICON[v.vacationType] || "📌", " ", v.name)), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left",
          padding: "6px 3px"
        }
      }, v.vacationType), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          fontWeight: 700,
          color: "#1b3a5c",
          padding: "6px 3px"
        }
      }, withSLabel(v.branch, v.date, v.dia, holidaySet)), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left",
          padding: "6px 3px"
        }
      }, cancelled ? "-" : v.confirmedBy ? /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#1caa5c"
        }
      }, "✅", v.confirmedBy) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#ccc"
        }
      }, "대기중"))));
    }))));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: cal.wrap
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.header
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.headerTop
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.userName
  }, currentUser === null || currentUser === void 0 ? void 0 : currentUser.name, "님"), isMidManager && /*#__PURE__*/React.createElement("button", {
    style: cal.switchUserBtn,
    onClick: onSwitchUser
  }, "전환")), /*#__PURE__*/React.createElement("div", {
    style: cal.headerBtnRow
  }, GS_ONLY && !isMidManager && !ghosting && /*#__PURE__*/React.createElement("a", {
    href: BAND_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      textDecoration: "none"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: adminStyles.bandBtn,
    type: "button"
  }, "💬 밴드")), !isMidManager && !ghosting && /*#__PURE__*/React.createElement("button", {
    style: adminStyles.adminBtn,
    onClick: () => openPanel(setShowMyVacations)
  }, "내 휴가현황"), !isMidManager && !ghosting && /*#__PURE__*/React.createElement("button", {
    style: adminStyles.adminBtn,
    onClick: () => openPanel(setShowLotteryApply)
  }, "🎋 명절 응모"), isMidManager && !ghosting && /*#__PURE__*/React.createElement("button", {
    style: adminStyles.adminBtn,
    onClick: () => openPanel(setShowHyuchungdangAdmin)
  }, "🔁 휴충당 신청 현황"), isAdmin && /*#__PURE__*/React.createElement("button", {
    style: adminStyles.adminBtn,
    onClick: () => openPanel(setShowAdminMenu)
  }, "⚙️ 관리자 메뉴"), isSuperAdmin && /*#__PURE__*/React.createElement("button", {
    style: {
      ...adminStyles.adminBtn,
      background: "#1a73e8",
      color: "#fff",
      borderColor: "#1a73e8"
    },
    onClick: () => setActingAsManager(v => !v)
  }, actingAsManager ? "🔧 기관사" : "🔧 운용"))), /*#__PURE__*/React.createElement("div", {
    style: cal.navRow
  }, /*#__PURE__*/React.createElement("button", {
    style: cal.navBtn,
    onClick: () => changeMonth(-1)
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.monthTitle
  }, viewYear, "년 ", viewMonth + 1, "월"), (viewYear !== now.getFullYear() || viewMonth !== now.getMonth()) && /*#__PURE__*/React.createElement("button", {
    style: {
      border: "1px solid rgba(255,255,255,0.4)",
      background: "transparent",
      color: "#cfe0ff",
      fontSize: "11px",
      fontWeight: 700,
      padding: "2px 8px",
      borderRadius: "6px"
    },
    onClick: () => {
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth());
    }
  }, "오늘로")), /*#__PURE__*/React.createElement("button", {
    style: cal.navBtn,
    onClick: () => changeMonth(1)
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: cal.weekRow
  }, WEEKDAYS.map((w, i) => /*#__PURE__*/React.createElement("div", {
    key: w,
    style: {
      color: i === 0 ? "#ff8a80" : i === 6 ? "#8ecdff" : "#c9d4de"
    }
  }, w))), /*#__PURE__*/React.createElement("div", {
    style: cal.railDivider
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: "hidden",
      width: "100%"
    },
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd
  }, /*#__PURE__*/React.createElement("div", {
    ref: gridRef,
    style: {
      ...cal.grid,
      transform: `translateX(${slideX}px)`,
      transition: slideTransition ? "transform 220ms ease" : "none"
    }
  }, cells.map((d, i) => {
    if (d === null) return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: cal.emptyCell
    });
    const key = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(d)}`;
    const dayType = getDayType(key, holidaySet);
    const branchRecords = (monthMap[key] || []).filter(v => v.branch === currentUser.branch);
    const activeRecords = branchRecords.filter(v => v.status !== "취소됨");
    const capacityCount = activeRecords.filter(v => isCapacityType(v.vacationType)).length;
    const prevKeyDate = new Date(viewYear, viewMonth, d - 1);
    const prevKey = `${prevKeyDate.getFullYear()}-${pad2(prevKeyDate.getMonth() + 1)}-${pad2(prevKeyDate.getDate())}`;
    const prevDayActive = (monthMap[prevKey] || []).filter(v => v.branch === currentUser.branch && v.status !== "취소됨");
    const capacity = gyeongsanCapacity(currentUser.branch, key, activeRecords, holidaySet, prevDayActive);
    const remain = capacity - capacityCount;
    const badge = /*#__PURE__*/React.createElement("div", {
      style: cal.dayBadge(gyeongsanColor(remain))
    }, activeRecords.length);
    const rawCodeForCell = codeForDate(key);
    const sLabelForCell = getSLabelOnly(currentUser.branch, key, rawCodeForCell, holidaySet);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: cal.dayCell(key === todayKey),
      onClick: () => openDate(d)
    }, /*#__PURE__*/React.createElement("div", {
      style: cal.dayNum(dayType)
    }, d), /*#__PURE__*/React.createElement("div", {
      style: cal.dayDivider
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        ...cal.dayCode(dayType),
        fontSize: sLabelForCell ? "10px" : cal.dayCode(dayType).fontSize
      }
    }, sLabelForCell ? `${rawCodeForCell}(${sLabelForCell})` : rawCodeForCell), badge);
  }))), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "10px"
    }
  }, "불러오는 중..."), selectedDate && (() => {
    const dayModalNode = /*#__PURE__*/React.createElement("div", {
      style: modal.overlay,
      onClick: isMidManager && isWideScreen ? undefined : closeModal
    }, /*#__PURE__*/React.createElement("div", {
      ref: dayModalSheetRef,
      style: {
        ...modal.sheet,
        ...(isMidManager && isWideScreen ? {
          position: "fixed",
          left: "50%",
          top: "3vh",
          transform: `translate(calc(-50% + ${dragPos.x}px), ${dragPos.y}px)`,
          margin: 0,
          maxWidth: "none",
          maxHeight: "none",
          width: `${dayModalWidth}px`,
          height: dayModalHeightStyle,
          padding: 0,
          overflow: "hidden"
        } : {})
      },
      onClick: e => e.stopPropagation()
    }, isMidManager && isWideScreen && /*#__PURE__*/React.createElement("button", {
      onClick: closeModal,
      style: {
        position: "absolute",
        top: "8px",
        right: "10px",
        border: "none",
        background: "transparent",
        color: "#999",
        fontSize: "20px",
        lineHeight: 1,
        cursor: "pointer",
        padding: "4px 6px",
        zIndex: 2
      },
      title: "닫기"
    }, "✕"), /*#__PURE__*/React.createElement("div", {
      style: isMidManager && isWideScreen ? {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "20px",
        boxSizing: "border-box",
        overflow: "hidden"
      } : {
        display: "contents"
      }
    }, isMidManager && isWideScreen && /*#__PURE__*/React.createElement("div", {
      onMouseDown: handleDragStart,
      style: {
        cursor: "grab",
        padding: "6px 0",
        marginBottom: "8px",
        textAlign: "center",
        color: "#ccc",
        fontSize: "16px",
        userSelect: "none",
        flexShrink: 0
      },
      title: "드래그해서 창 옮기기"
    }, "⋯⋯⋯"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "8px",
        flex: "1 1 auto",
        minHeight: 0
      }
    }, isMidManager && isWideScreen && prevDateStr && renderCompactDayColumn(prevDateStr, adjacentRecords.prev, "전날"), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: isMidManager && isWideScreen ? "4 4 0" : undefined,
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
        ...(isMidManager && isWideScreen ? {
          height: "100%",
          overflowY: "auto",
          padding: "14px"
        } : {})
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "hidden"
      },
      onTouchStart: handleDayTouchStart,
      onTouchMove: handleDayTouchMove,
      onTouchEnd: handleDayTouchEnd
    }, /*#__PURE__*/React.createElement("div", {
      ref: dayGridRef,
      style: {
        transform: `translateX(${daySlideX}px)`,
        transition: daySlideTransition ? "transform 220ms ease" : "none"
      }
    }, showManagerForm ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.dateTitle,
        color: dateHeaderColor(selectedDate, holidaySet)
      }
    }, formatDateHeader(selectedDate), " 대신 기록"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.countText,
        marginBottom: "20px"
      }
    }, "중간관리자(", currentUser.name, ") 기록"), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        color: "#555",
        marginBottom: "8px",
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: managerFormUnassigned,
      onChange: e => {
        setManagerFormUnassigned(e.target.checked);
        if (e.target.checked) setManagerTargetId("");
      }
    }), "대상자 미정으로 먼저 등록 (시운전 등 - 나중에 사람 배정)")), !managerFormUnassigned && /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "대상자"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: managerTargetId,
      onChange: e => {
        const empId = e.target.value;
        setManagerTargetId(empId);
        // 대상자를 고르면 그 사람 본인의 오늘 교번을 자동으로 채워줘요 - 운용이 매번
        // 목록에서 그 사람 교번을 따로 찾아 고를 필요 없게. 물론 그 뒤에 자유롭게 바꿀 수 있어요.
        setManagerFormDia(empId ? codeForEmployeeOnDate(empId, selectedDate) : "");
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "이름 선택"), [...branchAllEmployees].sort((a, b) => a.name.localeCompare(b.name, "ko")).map(emp => /*#__PURE__*/React.createElement("option", {
      key: emp.id,
      value: emp.id
    }, emp.name)))), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "휴가명"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: managerFormType,
      onChange: e => setManagerFormType(e.target.value)
    }, /*#__PURE__*/React.createElement("optgroup", {
      label: "⚪ 보장인원 미포함"
    }, NON_CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))), /*#__PURE__*/React.createElement("optgroup", {
      label: "🟢 보장인원 포함"
    }, CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))))), managerFormType === "기타" && /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "기타 사유"), /*#__PURE__*/React.createElement("input", {
      style: modal.input,
      value: managerFormOtherReason,
      onChange: e => setManagerFormOtherReason(e.target.value),
      placeholder: "예: 예비군훈련, 법원 출석 등"
    })), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "DIA"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: managerFormDia,
      onChange: e => setManagerFormDia(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번을 선택해주세요"), managerFormDia && !managerBranchCodes.includes(managerFormDia) && /*#__PURE__*/React.createElement("option", {
      value: managerFormDia
    }, managerFormDia, " (본인 교번)"), managerBranchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, withSLabel(currentUser.branch, selectedDate, c, holidaySet))))), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "비고 (선택)"), /*#__PURE__*/React.createElement("input", {
      style: modal.input,
      value: managerFormNote,
      onChange: e => setManagerFormNote(e.target.value),
      placeholder: "예: 제8차 재직자 보수교육(7.20~7.22)"
    })), /*#__PURE__*/React.createElement("button", {
      style: modal.addBtn,
      onClick: handleSubmitManagerRecord,
      disabled: managerSaving
    }, managerSaving ? "저장 중..." : "저장"), /*#__PURE__*/React.createElement("button", {
      style: modal.closeBtn,
      onClick: () => setShowManagerForm(false)
    }, "취소")) : showRegisterForm ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.dateTitle,
        color: dateHeaderColor(selectedDate, holidaySet)
      }
    }, formatDateHeader(selectedDate), " 휴가 신청"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.countText,
        marginBottom: "20px"
      }
    }, currentUser.name, "님 이름으로 등록돼요 · 내 교번: ", /*#__PURE__*/React.createElement("strong", null, withSLabel(currentUser.branch, selectedDate, codeForDate(selectedDate), holidaySet) || "-")), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "휴가명"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: formType,
      onChange: e => setFormType(e.target.value)
    }, /*#__PURE__*/React.createElement("optgroup", {
      label: "🟢 보장인원 포함"
    }, CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))), /*#__PURE__*/React.createElement("optgroup", {
      label: "⚪ 보장인원 미포함"
    }, /*#__PURE__*/React.createElement("option", {
      value: "청휴"
    }, "청휴"))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        marginTop: "6px",
        color: "#888"
      }
    }, "병가·교육 등은 중간관리자가 대신 기록해요")), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "DIA"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: formDia,
      onChange: e => setFormDia(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번을 선택해주세요"), managerBranchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, withSLabel(currentUser.branch, selectedDate, c, holidaySet)))), GS_ONLY && isThreeRoundTripCode(selectedDate, formDia, holidaySet) && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        marginTop: "6px",
        color: "#e08a20",
        fontWeight: 600
      }
    }, "⚠️ 이 교번은 3왕복이에요 - 가급적 휴가를 피해달라는 약속이 있어요 (부득이하면 그대로 신청하셔도 돼요)"), offDutyNightDia && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        marginTop: "6px",
        color: "#1b3a5c",
        fontWeight: 600
      }
    }, "🌙 비번이라 전날(", prevDateStr, ") 야간 ", offDutyNightDia, "도 같이 신청돼요 (두 날짜 자리 모두 확인해요)"), nightNextDayBlock && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        marginTop: "6px",
        color: "#e02020",
        fontWeight: 700
      }
    }, "🌙 야간 근무라 다음날(", nextDateStr, ")이 비번으로 이어지는데, 다음날 자리가 이미 다 차서 신청할 수 없어요.")), /*#__PURE__*/React.createElement("button", {
      style: modal.addBtn,
      onClick: handleSubmitRegister,
      disabled: saving || nightNextDayBlock
    }, saving ? "저장 중..." : "저장"), /*#__PURE__*/React.createElement("button", {
      style: modal.closeBtn,
      onClick: () => setShowRegisterForm(false)
    }, "취소")) : /*#__PURE__*/React.createElement(React.Fragment, null, isMidManager && isWideScreen && /*#__PURE__*/React.createElement("div", {
      style: {
        height: "64px",
        boxSizing: "border-box"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        fontWeight: 700,
        color: "#888",
        marginBottom: "2px"
      }
    }, "오늘"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "2px"
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "5px 9px",
        fontSize: "13px"
      },
      onClick: () => changeDay(-1)
    }, "‹"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "15px",
        fontWeight: 700,
        lineHeight: "22px",
        color: dateHeaderColor(selectedDate, holidaySet)
      }
    }, formatDateHeader(selectedDate)), /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "5px 9px",
        fontSize: "13px"
      },
      onClick: () => changeDay(1)
    }, "›")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "#1a1a1a",
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        gap: "8px"
      }
    }, "휴가자 ", activeCount, "명", gyeongsanInfo && ` · 보장대상 ${gyeongsanInfo.capacityCount}/${gyeongsanInfo.capacity}명 (여유 ${gyeongsanInfo.remain}명)`, isMidManager && /*#__PURE__*/React.createElement("button", {
      type: "button",
      style: {
        color: "#1a73e8",
        fontWeight: 700,
        background: "none",
        border: "none",
        padding: 0,
        fontFamily: "inherit",
        textDecoration: "underline",
        cursor: "pointer",
        userSelect: "none",
        WebkitUserSelect: "none"
      },
      onClick: () => renumberDayPriorities_(selectedDate, currentUser.branch, freshRecords => {
        setMonthMap(prev => ({
          ...prev,
          [selectedDate]: freshRecords
        }));
      })
    }, "🔄 순번 정리"))), !(isMidManager && isWideScreen) && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "4px"
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "6px 10px",
        fontSize: "14px"
      },
      onClick: () => changeDay(-1)
    }, "‹"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.dateTitle,
        marginBottom: 0,
        color: dateHeaderColor(selectedDate, holidaySet)
      }
    }, formatDateHeader(selectedDate)), /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "6px 10px",
        fontSize: "14px"
      },
      onClick: () => changeDay(1)
    }, "›")), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.countText,
        marginBottom: "4px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap"
      }
    }, "휴가자 ", activeCount, "명", gyeongsanInfo && ` · 보장대상 ${gyeongsanInfo.capacityCount}/${gyeongsanInfo.capacity}명 (여유 ${gyeongsanInfo.remain}명)`, isMidManager && /*#__PURE__*/React.createElement("button", {
      type: "button",
      style: {
        color: "#1a73e8",
        fontWeight: 700,
        fontSize: "12px",
        background: "none",
        border: "none",
        padding: 0,
        fontFamily: "inherit",
        textDecoration: "underline",
        cursor: "pointer",
        userSelect: "none",
        WebkitUserSelect: "none"
      },
      onClick: () => renumberDayPriorities_(selectedDate, currentUser.branch, freshRecords => {
        setMonthMap(prev => ({
          ...prev,
          [selectedDate]: freshRecords
        }));
      })
    }, "🔄 순번 정리")), !isMidManager && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px",
        color: "#1b3a5c",
        fontWeight: 700,
        marginTop: "2px",
        marginBottom: "6px"
      }
    }, "내 교번: ", withSLabel(currentUser.branch, selectedDate, codeForDate(selectedDate), holidaySet) || "-")), dayRecords.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: "#aaa",
        padding: "20px 0"
      }
    }, "등록된 휴가가 없어요"), dayRecords.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "auto",
        marginBottom: "12px"
      }
    }, /*#__PURE__*/React.createElement("table", {
      style: {
        width: "max-content",
        minWidth: "100%",
        borderCollapse: "collapse",
        fontSize: "13px"
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
      style: {
        borderBottom: "2px solid #333"
      }
    }, /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "#"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left"
      }
    }, "이름"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left"
      }
    }, "휴가명"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "DIA"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left"
      }
    }, "확인"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }))), /*#__PURE__*/React.createElement("tbody", null, sortedDayRecords.map((v, idx) => {
      const cancelled = v.status === "취소됨";
      const cap = isCapacityType(v.vacationType);
      const prevCap = idx > 0 ? isCapacityType(sortedDayRecords[idx - 1].vacationType) : null;
      const showGroupHeader = idx === 0 || cap !== prevCap;
      const canEditPriority = GS_ONLY && !cancelled && v.employeeId === currentUser.id && isCapacityType(v.vacationType) && v.createdAt && formatEntryDateOnly(v.createdAt) === koreaTodayStr() && isEvenMonthFirstDay();
      return /*#__PURE__*/React.createElement(React.Fragment, {
        key: v.id
      }, showGroupHeader && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
        colSpan: 6,
        style: {
          padding: "10px 4px 6px",
          fontSize: "15px",
          fontWeight: 800,
          color: cap ? "#1b3a5c" : "#666",
          background: cap ? "#eaf1ff" : "#f2f2f2",
          borderBottom: "1px solid #ddd"
        }
      }, cap ? "🟢 보장인원 포함" : "⚪ 보장인원 미포함")), /*#__PURE__*/React.createElement("tr", {
        style: {
          borderBottom: "1px solid #eee",
          opacity: cancelled ? 0.45 : 1,
          textDecoration: cancelled ? "line-through" : "none"
        }
      }, /*#__PURE__*/React.createElement("td", {
        style: tbl.td
      }, editingPriorityId === v.id ? /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: "2px",
          alignItems: "center"
        }
      }, /*#__PURE__*/React.createElement("input", {
        type: "number",
        value: priorityInput,
        onChange: e => setPriorityInput(e.target.value),
        style: {
          width: "36px",
          fontSize: "12px",
          padding: "2px"
        }
      }), /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0,
          color: "#1b3a5c"
        },
        onClick: () => handleSavePriorityEdit(v)
      }, "✓")) : canEditPriority ? /*#__PURE__*/React.createElement("span", {
        style: {
          textDecoration: "underline",
          cursor: "pointer",
          color: "#1b3a5c"
        },
        onClick: () => handleStartPriorityEdit(v)
      }, v.priority != null ? v.priority : idx + 1, "✏️") : v.priority != null ? v.priority : idx + 1), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontWeight: 700,
          fontSize: "13px",
          color: v.unassigned ? "#e08a20" : undefined
        }
      }, v.unassigned ? "🔔" : TYPE_ICON[v.vacationType] || "📌", " ", v.name), v.unassigned && isMidManager && (assigningRecordId === v.id ? /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: "4px",
          padding: "8px",
          background: "#fff7e6",
          border: "1px solid #f5cf7a",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          maxWidth: "150px"
        }
      }, /*#__PURE__*/React.createElement("select", {
        value: assignPersonId,
        onChange: e => handleAssignPersonSelect(v, e.target.value),
        style: {
          fontSize: "11px",
          padding: "3px"
        },
        autoFocus: true
      }, /*#__PURE__*/React.createElement("option", {
        value: ""
      }, "사람 선택"), [...branchAllEmployees].sort((a, b) => a.name.localeCompare(b.name, "ko")).map(emp => /*#__PURE__*/React.createElement("option", {
        key: emp.id,
        value: emp.id
      }, emp.name))), /*#__PURE__*/React.createElement("select", {
        value: assignDia,
        onChange: e => setAssignDia(e.target.value),
        style: {
          fontSize: "11px",
          padding: "3px"
        }
      }, /*#__PURE__*/React.createElement("option", {
        value: ""
      }, "DIA 선택"), managerBranchCodes.map(c => /*#__PURE__*/React.createElement("option", {
        key: c,
        value: c
      }, c))), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: "4px"
        }
      }, /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0,
          flex: 1,
          color: "#1caa5c"
        },
        onClick: () => handleConfirmAssign(v)
      }, "확정"), /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0,
          flex: 1
        },
        onClick: () => setAssigningRecordId(null)
      }, "취소"))) : /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: "11px",
          color: "#e08a20",
          textDecoration: "underline",
          cursor: "pointer"
        },
        onClick: () => startAssigning(v)
      }, "배정하기")), v.createdAt && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: "12px",
          color: "#333"
        }
      }, formatEntryTime(v.createdAt, v.createdAtDateOnly))), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left"
        }
      }, v.vacationType && v.vacationType.startsWith("기타:") ? "기타" : v.vacationType), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          fontWeight: 700,
          color: v.unassigned ? "#e08a20" : "#1b3a5c"
        }
      }, withSLabel(v.branch, v.date, v.dia, holidaySet)), /*#__PURE__*/React.createElement("td", {
        style: {
          ...tbl.td,
          textAlign: "left"
        }
      }, cancelled ? "-" : v.confirmedBy ? isMidManager && editingConfirmId === v.id ? /*#__PURE__*/React.createElement("select", {
        value: v.confirmedBy,
        onChange: e => {
          if (e.target.value === "__UNCONFIRM__") {
            handleUnconfirm(v);
          } else if (e.target.value) {
            handleConfirmStamp(v, e.target.value);
          }
          setEditingConfirmId(null);
        },
        onBlur: () => setEditingConfirmId(null),
        style: {
          fontSize: "11px",
          padding: "2px",
          maxWidth: "80px"
        },
        autoFocus: true
      }, branchManagerNames.map(name => /*#__PURE__*/React.createElement("option", {
        key: name,
        value: name
      }, name)), /*#__PURE__*/React.createElement("option", {
        value: "__UNCONFIRM__"
      }, "↩️ 확인 취소")) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#1caa5c",
          cursor: isMidManager ? "pointer" : "default"
        },
        onClick: () => isMidManager && setEditingConfirmId(v.id)
      }, "✅", v.confirmedBy, isMidManager && " ✏️") : isMidManager ? /*#__PURE__*/React.createElement("select", {
        value: "",
        onChange: e => {
          if (e.target.value) handleConfirmStamp(v, e.target.value);
        },
        style: {
          fontSize: "11px",
          padding: "2px",
          maxWidth: "80px"
        }
      }, /*#__PURE__*/React.createElement("option", {
        value: ""
      }, "확인"), branchManagerNames.map(name => /*#__PURE__*/React.createElement("option", {
        key: name,
        value: name
      }, name))) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#ccc"
        }
      }, "대기중")), /*#__PURE__*/React.createElement("td", {
        style: tbl.td
      }, !cancelled && v.employeeId === currentUser.id && !v.confirmedBy && !v.recordedBy && /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0
        },
        onClick: () => handleSelfCancelClick(v)
      }, "취소"), !cancelled && isMidManager && v.employeeId !== currentUser.id && isCapacityType(v.vacationType) && /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0
        },
        onClick: () => handleCancel(v)
      }, "취소"), !cancelled && isMidManager && v.employeeId !== currentUser.id && !isCapacityType(v.vacationType) && /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          color: "#e02020",
          margin: 0
        },
        onClick: () => handleAdminDelete(v)
      }, "삭제"), isAdmin && /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          color: "#999",
          margin: 0
        },
        onClick: () => handleAdminDelete(v)
      }, "🗑"))), (v.note || v.vacationType && v.vacationType.startsWith("기타:") || editingNoteId === v.id || !cap && isMidManager && !cancelled) && /*#__PURE__*/React.createElement("tr", {
        style: {
          borderBottom: "1px solid #eee"
        }
      }, /*#__PURE__*/React.createElement("td", null), /*#__PURE__*/React.createElement("td", {
        colSpan: 5,
        style: {
          padding: "0 3px 6px",
          fontSize: "11px"
        }
      }, v.vacationType && v.vacationType.startsWith("기타:") && /*#__PURE__*/React.createElement("div", {
        style: {
          color: "#e08a20",
          marginBottom: "2px"
        }
      }, v.vacationType), editingNoteId === v.id ? /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: "4px",
          alignItems: "center"
        }
      }, /*#__PURE__*/React.createElement("input", {
        value: noteInput,
        onChange: e => setNoteInput(e.target.value),
        placeholder: "비고 메모",
        style: {
          flex: 1,
          fontSize: "12px",
          padding: "3px 6px"
        }
      }), /*#__PURE__*/React.createElement("button", {
        style: {
          ...modal.smallCancelBtn,
          margin: 0,
          color: "#1b3a5c"
        },
        onClick: () => handleSaveNoteEdit(v)
      }, "✓")) : /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "6px"
        }
      }, v.note && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#999"
        }
      }, "📝 ", v.note), !cap && isMidManager && !cancelled && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#1b3a5c",
          textDecoration: "underline",
          cursor: "pointer"
        },
        onClick: () => handleStartNoteEdit(v)
      }, v.note ? "메모수정" : "+메모")))));
    })))), !isMidManager && !ghosting && (dayRecords.some(v => v.employeeId === currentUser.id && v.status !== "취소됨") ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: "#999",
        fontSize: "13px",
        padding: "10px 0"
      }
    }, "이미 이 날짜에 신청하셨어요") : gyeongsanInfo && gyeongsanInfo.remain <= 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: "#e02020",
        fontSize: "13px",
        padding: "10px 0"
      }
    }, "이 날짜는 보장인원이 다 찼어요 (여유 0명)") : /*#__PURE__*/React.createElement("button", {
      style: modal.addBtn,
      onClick: () => setShowRegisterForm(true)
    }, "+ 휴가 신청")), isMidManager && /*#__PURE__*/React.createElement("button", {
      style: {
        ...modal.addBtn,
        background: "#1a73e8"
      },
      onClick: openManagerForm
    }, "+ 대신 기록 (병가·청휴·교육 등)"), !isMidManager && !ghosting && String(codeForDate(selectedDate) || "").startsWith("휴") && (myHyuchungdangRequest ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        fontSize: "13px",
        padding: "10px 0",
        color: "#e08a20",
        fontWeight: 600
      }
    }, "🔁 휴충당 신청 완료", " ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#e02020",
        textDecoration: "underline",
        cursor: "pointer",
        fontWeight: 400
      },
      onClick: () => handleCancelHyuchungdang(myHyuchungdangRequest.id)
    }, "신청취소")) : /*#__PURE__*/React.createElement("button", {
      style: {
        ...modal.addBtn,
        background: "#e08a20",
        marginTop: "6px"
      },
      onClick: handleApplyHyuchungdang
    }, "🔁 휴충당 신청")), /*#__PURE__*/React.createElement("button", {
      style: modal.closeBtn,
      onClick: closeModal
    }, "닫기"))))), isMidManager && isWideScreen && nextDateStr && renderCompactDayColumn(nextDateStr, adjacentRecords.next, "다음날"))), isMidManager && isWideScreen && /*#__PURE__*/React.createElement("div", {
      onMouseDown: handleResizeStart,
      style: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "10px",
        cursor: "ns-resize"
      },
      title: "아래로 드래그해서 높이 조절"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: "36px",
        height: "4px",
        borderRadius: "2px",
        background: "#ccc",
        margin: "3px auto 0"
      }
    }))));
    return isMidManager && isWideScreen ? ReactDOM.createPortal(dayModalNode, document.body) : dayModalNode;
  })(), showAdminMenu && /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: closeModal
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "340px"
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, "⚙️ 관리자 메뉴"), GS_ONLY && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "10px",
      padding: "8px 12px",
      marginBottom: "14px",
      fontSize: "12px",
      color: "#666"
    }
  }, "📤 마지막 백업: ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: "#1b3a5c"
    }
  }, lastBackupText)), /*#__PURE__*/React.createElement("button", {
    style: styles.button,
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowAdmin);
    }
  }, "승인 관리"), /*#__PURE__*/React.createElement("button", {
    style: styles.button,
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowManagerAdmin);
    }
  }, "운용 인원"), /*#__PURE__*/React.createElement("button", {
    style: styles.button,
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowRosterChange);
    }
  }, "🔀 교번 변경 예약"), /*#__PURE__*/React.createElement("button", {
    style: styles.button,
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowLotteryAdmin);
    }
  }, "🎋 명절 추첨 관리"), false && /*#__PURE__*/React.createElement("button", {
    style: styles.button,
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowImportTest);
    }
  }, "가져오기 테스트"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e08a20",
      color: "#e08a20"
    },
    onClick: () => {
      setShowAdminMenu(false);
      openPanel(setShowDataReset);
    }
  }, "🗑️ 데이터 초기화"), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: closeModal
  }, "닫기"))), showAdmin && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(AdminPanel, {
    branch: currentUser.branch,
    isSuperAdmin: isSuperAdmin,
    onClose: closeModal,
    employees: employees,
    managers: managers
  })), showManagerAdmin && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(ManagerAdminPanel, {
    branch: currentUser.branch,
    isSuperAdmin: isSuperAdmin,
    onClose: closeModal
  })), showRosterChange && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(RosterChangePanel, {
    branch: currentUser.branch,
    isSuperAdmin: isSuperAdmin,
    onClose: closeModal,
    employees: employees,
    currentUser: currentUser
  })), showDataReset && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(DataResetPanel, {
    onClose: closeModal,
    branch: currentUser.branch
  })), showImportTest && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(ImportTestPanel, {
    onClose: closeModal,
    employees: employees,
    managers: managers
  })), showMyVacations && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(MyVacationsPanel, {
    currentUser: currentUser,
    onClose: closeModal,
    employees: employees
  })), showLotteryAdmin && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(LotteryAdminPanel, {
    branch: currentUser.branch,
    isSuperAdmin: isSuperAdmin,
    onClose: closeModal,
    employees: employees,
    managers: managers,
    holidaySet: holidaySet
  })), showLotteryApply && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(LotteryApplyPanel, {
    currentUser: currentUser,
    onClose: closeModal,
    employees: employees,
    holidaySet: holidaySet
  })), showHyuchungdangAdmin && /*#__PURE__*/React.createElement(ErrorBoundary, {
    onClose: closeModal
  }, /*#__PURE__*/React.createElement(HyuchungdangAdminPanel, {
    branch: currentUser.branch,
    onClose: closeModal,
    employees: employees,
    managers: managers,
    holidaySet: holidaySet
  })), !isMidManager && hyuchungdangResultsToShow.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.overlay,
      alignItems: "safe center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "340px",
      borderRadius: "16px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      marginBottom: "10px"
    }
  }, "🔁"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "15px",
      fontWeight: 700,
      marginBottom: "12px"
    }
  }, "휴충당이 확정됐어요"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "left"
    }
  }, hyuchungdangResultsToShow.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      background: "#fff7e6",
      border: "1px solid #f5cf7a",
      borderRadius: "10px",
      padding: "10px 12px",
      marginBottom: "8px",
      fontSize: "13px"
    }
  }, r.name, "기관사님, ", r.date, " (", weekdayShort(r.date), ") ", r.originalDia, "이(가)", " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: "#e08a20"
    }
  }, r.substituteDia), "로 휴충당 확정 되었습니다."))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: () => setHyuchungdangResultsToShow([])
  }, "확인"))), showEtiquetteNotice && !isMidManager && hyuchungdangResultsToShow.length === 0 && lotteryResultsToShow.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.overlay,
      alignItems: "safe center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "340px",
      borderRadius: "16px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      marginBottom: "10px"
    }
  }, "🎋"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "15px",
      fontWeight: 700,
      marginBottom: "12px"
    }
  }, "명절 연휴 추첨 결과가 나왔어요"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "left"
    }
  }, lotteryResultsToShow.map(en => /*#__PURE__*/React.createElement("div", {
    key: en.id,
    style: {
      background: "#f3eaff",
      border: "1px solid #d3b8f5",
      borderRadius: "10px",
      padding: "10px 12px",
      marginBottom: "8px",
      fontSize: "13px"
    }
  }, en.date, " (", weekdayShort(en.date), ") · ", en.vacationType, " ·", " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: en.result === "당첨" ? "#1caa5c" : "#e02020"
    }
  }, en.result)))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: () => setShowEtiquetteNotice(false)
  }, "확인"))), showEtiquetteNotice && !isMidManager && hyuchungdangResultsToShow.length === 0 && lotteryResultsToShow.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.overlay,
      alignItems: "safe center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "340px",
      borderRadius: "16px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      marginBottom: "10px"
    }
  }, "🙏"), !evenMonthOpenInfo && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "15px",
      fontWeight: 600,
      lineHeight: 1.5,
      marginBottom: "18px"
    }
  }, "휴가 자리는 여러 사람이 함께 쓰는 만큼, 서로 배려하는 마음으로 신청·취소는 신중하게 부탁드려요^^"), evenMonthOpenInfo && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#eaf1ff",
      border: "1px solid #b8d0f5",
      borderRadius: "10px",
      padding: "12px",
      marginBottom: "14px",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: 800,
      color: "#1b3a5c",
      marginBottom: "8px"
    }
  }, "📢 ", evenMonthOpenInfo.next1Year, "년 ", evenMonthOpenInfo.next1Month, "·", evenMonthOpenInfo.next2Month, "월 휴가 장부 오픈 안내"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#333",
      lineHeight: 1.7
    }
  }, "-오픈 일시: ", evenMonthOpenInfo.openMonth, "월1일(", evenMonthOpenInfo.isOpeningToday ? "오늘" : "내일", ") 오전 9시", /*#__PURE__*/React.createElement("br", null), "-작성 방법: 밴드에 휴가작성 → D휴가앱에 직접 작성(밴드 작성순서 필히 확인)"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 700,
      color: "#e02020",
      marginTop: "10px",
      marginBottom: "2px"
    }
  }, "⚠️ 유의사항"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#333",
      lineHeight: 1.7
    }
  }, "- ", evenMonthOpenInfo.openMonth, "/1 ~ ", evenMonthOpenInfo.openMonth, "/5 신청 휴가 : 취소 불가 (단, ", evenMonthOpenInfo.openMonth, "/1 신청분은 ", evenMonthOpenInfo.openMonth, "/1 당일에 한해 취소 가능)", /*#__PURE__*/React.createElement("br", null), "- 휴가 취소 규정 : 휴가일 기준 최소 7일 전까지 취소 필수(예: 휴가일에서 -7일 계산)", /*#__PURE__*/React.createElement("br", null), "- 작성 순서 준수 : 밴드 순서 확인 후 → D휴가앱에 해당 순번에 맞게 작성"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "#666",
      marginTop: "10px"
    }
  }, "서로 간의 약속이니, 동료들을 위해 배려와 규정 준수 부탁드립니다.")), upcomingUnconfirmed.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#fff7e6",
      border: "1px solid #f5cf7a",
      borderRadius: "10px",
      padding: "12px",
      marginBottom: "14px",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 700,
      color: "#e08a20",
      marginBottom: "6px"
    }
  }, "⏰ 5일 이내 확인 대기중인 신청이 있어요"), upcomingUnconfirmed.map(v => /*#__PURE__*/React.createElement("div", {
    key: v.id,
    style: {
      fontSize: "13px",
      color: "#333",
      marginTop: "2px"
    }
  }, v.date, " (", weekdayShort(v.date), ") · ", v.vacationType))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: () => setShowEtiquetteNotice(false)
  }, "확인"))), showEtiquetteNotice && isMidManager && (branchUpcomingUnconfirmed.length > 0 || evenMonthOpenInfo) && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.overlay,
      alignItems: "safe center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "360px",
      borderRadius: "16px"
    }
  }, evenMonthOpenInfo && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#eaf1ff",
      border: "1px solid #b8d0f5",
      borderRadius: "10px",
      padding: "12px",
      marginBottom: "14px",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: 800,
      color: "#1b3a5c",
      marginBottom: "6px"
    }
  }, "📢 ", evenMonthOpenInfo.next1Year, "년 ", evenMonthOpenInfo.next1Month, "·", evenMonthOpenInfo.next2Month, "월 휴가 장부 오픈 안내"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#333",
      lineHeight: 1.6
    }
  }, "-오픈 일시: ", evenMonthOpenInfo.openMonth, "월1일(", evenMonthOpenInfo.isOpeningToday ? "오늘" : "내일", ") 오전 9시", /*#__PURE__*/React.createElement("br", null), "-", evenMonthOpenInfo.openMonth, "/1 ~ ", evenMonthOpenInfo.openMonth, "/5 신청 휴가 : 취소 불가", /*#__PURE__*/React.createElement("br", null), "-휴가 취소는 휴가일 기준 최소 7일 전까지 필수")), branchUpcomingUnconfirmed.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "15px",
      fontWeight: 700,
      marginBottom: "12px",
      textAlign: "center"
    }
  }, "⏰ 5일 이내 확인 대기중인 신청 (", branchUpcomingUnconfirmed.length, "건)"), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: "50vh",
      overflowY: "auto",
      marginBottom: "14px"
    }
  }, branchUpcomingUnconfirmed.map(v => /*#__PURE__*/React.createElement("div", {
    key: v.id,
    style: {
      background: "#fff7e6",
      border: "1px solid #f5cf7a",
      borderRadius: "10px",
      padding: "8px 10px",
      marginBottom: "6px",
      fontSize: "13px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, v.date, " (", weekdayShort(v.date), ") · ", v.name), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#666"
    }
  }, v.vacationType, " · ", v.dia))))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: () => setShowEtiquetteNotice(false)
  }, "확인"))));
}

/* ------------------------------------------------------------------ */
/* 관리자 승인 패널 (관리자 이름으로 로그인했을 때만 버튼 노출)             */
/* ------------------------------------------------------------------ */
// 관리자로 지정할 이름 목록. 나중에 관리자가 바뀌면 여기 이름만 수정/추가하면 돼요.
const ADMIN_NAMES = [{
  name: "권재림",
  branch: "문양"
}];

// 이름뿐 아니라 소속까지 같아야 관리자로 인정 (다른 소속 동명이인 방지)
function isAdminUser(user) {
  if (!user) return false;
  return ADMIN_NAMES.some(a => a.name === user.name && a.branch === user.branch);
}

// 전체관리자(앱 총괄) - 소속과 무관하게 모든 소속의 승인관리·운용인원·명절추첨을 볼 수 있고,
// 운용 등록 여부와 무관하게 운용 화면(대신 기록·확인·휴충당 관리 등)에도 자유롭게 접근할 수 있어요.
// 로그인은 평소처럼 한 소속으로 하되, 관리 화면 안에서 소속을 전환(고스트 모드)할 수 있어요.
//
// ⚠️ 나중에 안정화되면 이 SUPER_ADMIN_CROSS_BRANCH 한 줄만 false로 바꾸면 깔끔하게 종료돼요.
// (TEST_MODE와 같은 방식) - 꺼지면 "🔀 전환" 버튼, 관리 화면의 소속 탭, 운용 자동부여가
// 전부 자동으로 사라져요.
const SUPER_ADMIN_CROSS_BRANCH = true;
const SUPER_ADMIN_NAMES = ["권재림"];
function isSuperAdminUser(user) {
  if (!SUPER_ADMIN_CROSS_BRANCH) return false;
  if (!user) return false;
  return SUPER_ADMIN_NAMES.includes(user.name);
}
const adminStyles = {
  approveBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#1caa5c",
    color: "#fff",
    fontWeight: 700,
    fontSize: "13px"
  },
  rejectBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#e02020",
    color: "#fff",
    fontWeight: 700,
    fontSize: "13px"
  },
  adminBtn: {
    padding: "5px 8px",
    borderRadius: "7px",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#1b3a5c",
    fontWeight: 700,
    fontSize: "11px",
    whiteSpace: "nowrap",
    flexShrink: 0
  },
  tabBtn: {
    flex: 1,
    padding: "9px 0",
    borderRadius: "8px",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#888",
    fontWeight: 700,
    fontSize: "13px"
  },
  tabBtnActive: {
    flex: 1,
    padding: "9px 0",
    borderRadius: "8px",
    border: "1px solid #1b3a5c",
    background: "#1b3a5c",
    color: "#fff",
    fontWeight: 700,
    fontSize: "13px"
  },
  resetBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#e08a20",
    color: "#fff",
    fontWeight: 700,
    fontSize: "13px"
  },
  bandBtn: {
    padding: "5px 10px",
    borderRadius: "7px",
    border: "none",
    background: "#00c73c",
    color: "#fff",
    fontWeight: 700,
    fontSize: "11px",
    whiteSpace: "nowrap",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "3px"
  }
};
function MyVacationsPanel({
  currentUser,
  onClose,
  employees
}) {
  const [list, setList] = useState([]);
  const [yearStats, setYearStats] = useState([]); // 올해 종류별 보장휴가 사용 개수
  const [hyuchungdangList, setHyuchungdangList] = useState([]); // 내가 신청한 휴충당 목록 (경산 전용, 신청중+취소됨 둘 다)
  const [hyuchungdangConfirmedCount, setHyuchungdangConfirmedCount] = useState(0); // 올해 확정 휴충당 개수
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // 휴가종류 수정 중인 기록 id
  const [editType, setEditType] = useState("");
  const [editDia, setEditDia] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // 교번틀 드롭다운용 - 본인 소속의 교번 코드 목록 (오타 방지)
  const myTeamKey = REVERSE_TEAM_MAP[currentUser.branch];
  const myOrder = GYOBUN_ORDER[myTeamKey] || [];
  const branchEmployees = (employees || []).filter(e => e.branch === currentUser.branch);
  const templateCodes = myOrder.filter(c => branchEmployees.some(e => e.code === c));
  const otherCodes = [...new Set(branchEmployees.map(e => e.code))].filter(c => !templateCodes.includes(c));
  const branchCodes = [...templateCodes, ...otherCodes];
  const load = () => {
    setLoading(true);
    const today = todayStr();
    const currentYear = today.slice(0, 4);
    // 실제로 쓰는 범위는 "올해 1월 1일부터"뿐이라(작년 이전 데이터는 이 화면에서 안 씀),
    // 그만큼만 좁혀서 읽어와요. 미래 신청도 보여줘야 해서 위쪽은 넉넉하게 내년 말까지 열어둬요.
    const fromDate = `${currentYear}-01-01`;
    const toDate = `${parseInt(currentYear, 10) + 1}-12-31`;
    const dayBeforeThisYear = `${parseInt(currentYear, 10) - 1}-12-31`;
    waitForFirestore().then(() => Promise.all([VacFacade.getMineByRange(currentUser.id, currentUser.branch, fromDate, toDate), true ? window.HyuchungdangAPI.listMineFrom(currentUser.id, dayBeforeThisYear) : Promise.resolve([])])).then(([records, hyuchungdangRecords]) => {
      const upcoming = records.filter(v => v.date >= today && isCapacityType(v.vacationType)).sort((a, b) => a.date.localeCompare(b.date));
      setList(upcoming);

      // 오늘 이후 신청 내역만 (신청중/취소됨 둘 다 - 취소된 건 취소선으로 계속 보여줌)
      setHyuchungdangList((hyuchungdangRecords || []).filter(r => r.date >= today).sort((a, b) => a.date.localeCompare(b.date)));

      // 올해 확정(충당교번+확인까지 마친) 휴충당 개수
      const confirmedCount = (hyuchungdangRecords || []).filter(r => r.date.startsWith(currentYear) && r.status !== "취소됨" && r.confirmedBy).length;
      setHyuchungdangConfirmedCount(confirmedCount);

      // 올해(1월 1일부터) 보장휴가만, 취소되지 않은 것만 종류별로 집계
      // 단, 연차비/분지비/장재비는 야간근무 시 다음날에 같이 기록되는 것일 뿐 실제 사용 개수는 아니라서 집계에서 제외해요
      const NIGHT_SHIFT_COMPANION_TYPES = ["연차비", "분지비", "장재비"];
      const counts = {};
      records.filter(v => v.date.startsWith(currentYear) && v.status !== "취소됨" && isCapacityType(v.vacationType) && !NIGHT_SHIFT_COMPANION_TYPES.includes(v.vacationType)).forEach(v => {
        counts[v.vacationType] = (counts[v.vacationType] || 0) + 1;
      });
      const stats = CAPACITY_TYPES.filter(t => counts[t]).map(t => ({
        type: t,
        count: counts[t]
      }));
      setYearStats(stats);
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);
  const handleCancelMyHyuchungdang = reqId => {
    if (!confirm("휴충당 신청을 취소할까요?")) return;
    window.HyuchungdangAPI.cancel(reqId).then(() => {
      setHyuchungdangList(prev => prev.map(r => r.id === reqId ? {
        ...r,
        status: "취소됨"
      } : r));
    }).catch(err => alert("취소 실패: " + (err && err.message ? err.message : err)));
  };
  const handleCancelMine = record => {
    const check = checkSelfCancelAllowed(currentUser.branch, record);
    if (!check.ok) {
      alert("⚠️ " + check.reason);
      return;
    }
    if (!confirm(`${record.date} ${record.vacationType} 기록을 취소할까요?`)) return;
    VacFacade.cancel(record.branch, record.date, record.id).then(() => {
      setList(prev => prev.map(v => v.id === record.id ? {
        ...v,
        status: "취소됨"
      } : v));
      // 취소로 순번에 구멍이 생기니, 같은 날짜의 남은 보장휴가 기록들 순번을 다시 매겨요
      if (isCapacityType(record.vacationType)) {
        renumberDayPriorities_(record.date, record.branch);
      }
      // 야간/비번 짝이 있으면 반대쪽도 같이 취소 (이 목록에 있으면 화면도 같이 갱신)
      cancelNightPairIfAny(record, pairRecord => {
        setList(prev => prev.some(v => v.id === pairRecord.id) ? prev.map(v => v.id === pairRecord.id ? {
          ...v,
          status: "취소됨"
        } : v) : prev);
        // 짝(주로 야간 쪽) 날짜도 순번에 구멍이 생기니 같이 정리해요
        if (isCapacityType(pairRecord.vacationType)) {
          renumberDayPriorities_(pairRecord.date, pairRecord.branch);
        }
      });
    });
  };
  const handleStartEdit = record => {
    // 비번(연차비 등)은 야간 신청에 딸려 자동 생성된 기록이라, 직접 수정하게 두면 야간 쪽과 어긋날 수 있어요.
    // 야간 쪽을 수정하면 비번도 자동으로 같이 맞춰지니, 여기서는 야간 기록을 수정해달라고 안내해요.
    if (NIGHT_COMPANION_TYPES_REVERSE[record.vacationType]) {
      alert("이 기록은 야간 신청에 따라 자동 등록된 비번이에요. 전날 야간 기록을 수정하면 이 비번도 같이 바뀌어요.");
      return;
    }
    setEditingId(record.id);
    setEditType(record.vacationType);
    setEditDia(record.dia || "");
  };
  const handleSaveTypeEdit = record => {
    const trimmedDia = editDia.trim();
    if (editType === record.vacationType && trimmedDia === (record.dia || "")) {
      setEditingId(null);
      return;
    }
    setEditSaving(true);
    findNightPair(record).then(pairRecord => VacFacade.update(record.branch, record.date, record.id, {
      vacationType: editType,
      dia: trimmedDia
    }).then(() => pairRecord)).then(pairRecord => {
      setList(prev => prev.map(v => v.id === record.id ? {
        ...v,
        vacationType: editType,
        dia: trimmedDia
      } : v));
      setEditingId(null);
      if (!pairRecord) return null;
      // 원래 야간이라 짝 비번이 있었는데, 수정 후에도 여전히 야간이면 짝도 새 값에 맞게 갱신하고,
      // 더 이상 야간이 아니게 바뀌었으면(비야간 DIA로 바꿈) 짝 비번은 더 이상 유효하지 않으니 취소해요.
      const newCompanionType = NIGHT_COMPANION_TYPE_MAP[editType];
      const stillNight = newCompanionType && isNightShiftCode(trimmedDia, record.branch);
      if (stillNight) {
        const newCompanionDia = nightDiaToOffDutyDia(trimmedDia);
        return VacFacade.update(pairRecord.branch, pairRecord.date, pairRecord.id, {
          vacationType: newCompanionType,
          dia: newCompanionDia
        }).then(() => {
          setList(prev => prev.map(v => v.id === pairRecord.id ? {
            ...v,
            vacationType: newCompanionType,
            dia: newCompanionDia
          } : v));
        });
      }
      return VacFacade.cancel(pairRecord.branch, pairRecord.date, pairRecord.id).then(() => {
        setList(prev => prev.some(v => v.id === pairRecord.id) ? prev.map(v => v.id === pairRecord.id ? {
          ...v,
          status: "취소됨"
        } : v) : prev);
        alert("수정하신 내용은 더 이상 야간 근무가 아니라서, 다음날 자동 등록됐던 비번은 취소했어요.");
      });
    }).catch(err => alert("수정 실패: " + (err && err.message ? err.message : err))).finally(() => setEditSaving(false));
  };
  const currentYear = todayStr().slice(0, 4);
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, currentUser.name, "님의 예정된 휴가"), !loading && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "10px",
      padding: "10px 14px",
      marginBottom: "16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      fontWeight: 600,
      color: "#888",
      marginBottom: "6px"
    }
  }, currentYear, "년 보장휴가 사용 현황"), yearStats.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#aaa"
    }
  }, "올해 사용한 보장휴가가 없어요") : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: 700,
      color: "#1b3a5c"
    }
  }, yearStats.map(s => `${s.type} ${s.count}`).join(" · "))), !loading && hyuchungdangList.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#fff7e6",
      border: "1px solid #f5cf7a",
      borderRadius: "10px",
      padding: "10px 14px",
      marginBottom: "16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "6px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      fontWeight: 700,
      color: "#e08a20"
    }
  }, "🔁 신청한 휴충당"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "#888"
    }
  }, "올해 확정 휴충당 ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: "#e08a20"
    }
  }, hyuchungdangConfirmedCount, "건"))), hyuchungdangList.map(r => {
    const cancelled = r.status === "취소됨";
    const confirmed = !cancelled && r.confirmedBy && r.substituteDia;
    return /*#__PURE__*/React.createElement("div", {
      key: r.id,
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: "13px",
        padding: "3px 0",
        opacity: cancelled ? 0.5 : 1,
        textDecoration: cancelled ? "line-through" : "none"
      }
    }, /*#__PURE__*/React.createElement("span", null, r.date, " (", weekdayShort(r.date), ")", confirmed ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#1caa5c",
        fontWeight: 700
      }
    }, " ", "· ", r.originalDia, "→", r.substituteDia, "충당 확정") : r.originalDia && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#1b3a5c",
        fontWeight: 700
      }
    }, " · ", r.originalDia)), !cancelled && !confirmed && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#e02020",
        textDecoration: "underline",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: () => handleCancelMyHyuchungdang(r.id)
    }, "취소"));
  })), /*#__PURE__*/React.createElement("div", {
    style: modal.countText
  }, "오늘부터 이후 신청 내역이에요"), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && list.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "예정된 휴가가 없어요"), !loading && list.map(v => {
    const cancelled = v.status === "취소됨";
    return /*#__PURE__*/React.createElement("div", {
      key: v.id,
      style: {
        ...modal.card,
        flexDirection: "column",
        alignItems: "stretch",
        ...(cancelled ? modal.cancelledCard : {})
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: modal.name
    }, v.date, " (", weekdayShort(v.date), ")"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: modal.dia
    }, v.dia), !cancelled && !v.confirmedBy && !v.recordedBy && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      style: {
        ...modal.smallCancelBtn,
        color: "#1b3a5c"
      },
      onClick: () => handleStartEdit(v)
    }, "수정"), /*#__PURE__*/React.createElement("button", {
      style: modal.smallCancelBtn,
      onClick: () => handleCancelMine(v)
    }, "취소")))), editingId === v.id ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginTop: "8px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "6px",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: 1.4,
        marginBottom: 0
      },
      value: editType,
      onChange: e => setEditType(e.target.value)
    }, /*#__PURE__*/React.createElement("optgroup", {
      label: "🟢 보장인원 포함"
    }, CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))), /*#__PURE__*/React.createElement("optgroup", {
      label: "⚪ 보장인원 미포함"
    }, /*#__PURE__*/React.createElement("option", {
      value: "청휴"
    }, "청휴"))), /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: 1,
        marginBottom: 0
      },
      value: editDia,
      onChange: e => setEditDia(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번 선택"), editDia && !branchCodes.includes(editDia) && /*#__PURE__*/React.createElement("option", {
      value: editDia
    }, editDia, " (기존값)"), branchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, c)))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "6px",
        justifyContent: "flex-end"
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: adminStyles.approveBtn,
      disabled: editSaving,
      onClick: () => handleSaveTypeEdit(v)
    }, "저장"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...modal.smallCancelBtn,
        margin: 0
      },
      onClick: () => setEditingId(null)
    }, "취소"))) : /*#__PURE__*/React.createElement("div", {
      style: modal.typeRow
    }, TYPE_ICON[v.vacationType] || "📌", " ", v.vacationType, v.confirmedBy ? ` · ✅${v.confirmedBy} 확인` : " · 확인 대기중"), !cancelled && v.confirmedBy && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "#1a1a1a",
        marginTop: "4px"
      }
    }, "확인완료 · 취소는 관리자에게 문의해주세요"));
  }), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 명절 연휴 추첨 - 응모 패널 (기관사 전용)                                */
/* ------------------------------------------------------------------ */
function LotteryApplyPanel({
  currentUser,
  onClose,
  employees,
  holidaySet
}) {
  const [events, setEvents] = useState([]);
  const [myEntries, setMyEntries] = useState([]);
  const [entryCountByDate, setEntryCountByDate] = useState({}); // "eventId_date" -> 응모자 수
  const [loading, setLoading] = useState(true);
  const [formState, setFormState] = useState({}); // { [date]: { type, dia } }
  const [saving, setSaving] = useState(false);

  // 본인 교번틀 기준으로 그 날짜의 실제 교번을 계산 (자기 휴가 신청 폼과 동일한 방식)
  // 이름+소속 우선, ID는 보조로 찾아요 (본인 신청 폼과 동일한 방식 - 위 주석 참고)
  const myEmp = (employees || []).find(e => e.name === currentUser.name && e.branch === currentUser.branch) || (employees || []).find(e => e.id === currentUser.id);
  const myBaseCode = myEmp ? myEmp.baseCode : "";
  const myTeamKey = REVERSE_TEAM_MAP[currentUser.branch];
  const myOrder = GYOBUN_ORDER[myTeamKey] || [];

  // DIA 드롭다운용 - 소속 교번틀 코드 목록 (자유입력으로 인한 오타/이상값 방지)
  const branchEmployeesForDia = (employees || []).filter(e => e.branch === currentUser.branch);
  const templateCodesForDia = myOrder.filter(c => branchEmployeesForDia.some(e => e.code === c));
  const otherCodesForDia = [...new Set(branchEmployeesForDia.map(e => e.code))].filter(c => !templateCodesForDia.includes(c));
  const branchCodesForDia = [...templateCodesForDia, ...otherCodesForDia];
  const codeForDate = dateStr => {
    if (!BASE_DATE || !myOrder.length) return "";
    // 교번 변경 예약이 있으면 그 날짜에 앉아 있는 자리의 교번으로 계산
    const bc = baseCodeForPersonOnDate_(employees, currentUser.name, currentUser.branch, dateStr, myBaseCode);
    if (!bc) return "";
    const offset = diffDays_(BASE_DATE, dateStr);
    return shiftCodeByDays_(myOrder, bc, offset);
  };
  const load = () => {
    setLoading(true);
    waitForFirestore().then(() => Promise.all([loadCachedList(LOTTERY_EVENTS_CACHE_KEY, LOTTERY_EVENTS_CACHE_TTL_MS, () => window.LotteryAPI.listEvents()), window.LotteryAPI.listMyEntries(currentUser.id)])).then(([eventList, entryList]) => {
      const ksEvents = (eventList || []).filter(e => e.branch === currentUser.branch);
      setEvents(ksEvents);
      setMyEntries(entryList || []);
      return Promise.all(ksEvents.map(e => window.LotteryAPI.listEntriesForEvent(e.id)));
    }).then(entryLists => {
      const counts = {};
      (entryLists || []).forEach(list => {
        (list || []).forEach(en => {
          const key = `${en.eventId}_${en.date}`;
          counts[key] = (counts[key] || 0) + 1;
        });
      });
      setEntryCountByDate(counts);
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);
  const today = todayStr();
  const openEvents = events.filter(e => e.applyStart <= today && today <= e.applyEnd && e.status === "응모중");
  const upcomingEvents = events.filter(e => e.applyStart > today && e.status === "응모중");
  const pastEvents = events.filter(e => !openEvents.includes(e) && !upcomingEvents.includes(e));
  const entryFor = (eventId, date) => myEntries.find(en => en.eventId === eventId && en.date === date);
  const handleApply = (event, date) => {
    const state = formState[date] || {};
    if (!state.type) {
      alert("휴가 종류를 선택해주세요");
      return;
    }
    const dia = normalizeSInput_(currentUser.branch, date, state.dia && state.dia.trim() || codeForDate(date), holidaySet);
    if (!dia) {
      alert("DIA를 입력해주세요");
      return;
    }
    const entryId = `${event.id}_${currentUser.id}_${date}`;
    setSaving(true);
    window.LotteryAPI.apply(entryId, {
      eventId: event.id,
      employeeId: currentUser.id,
      name: currentUser.name,
      branch: currentUser.branch,
      date,
      vacationType: state.type,
      dia
    }).then(() => load()).catch(err => alert("응모 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };

  // 야간(2일 연계) 응모 - 첫날+다음날을 하나로 묶어서 응모. 추첨 때 둘 다 당첨돼야 확정되고,
  // 하나만 당첨되는 경우는 없도록(둘 다 낙첨 처리) 관리자 패널에서 처리해요.
  const handleApplyLinked = (event, date, nextDate) => {
    const state = formState[date] || {};
    if (!state.type) {
      alert("1일차 휴가 종류를 선택해주세요");
      return;
    }
    const dia = normalizeSInput_(currentUser.branch, date, state.dia && state.dia.trim() || codeForDate(date), holidaySet);
    if (!dia) {
      alert("1일차 DIA를 입력해주세요");
      return;
    }
    if (!state.nextType) {
      alert("2일차 휴가 종류를 선택해주세요");
      return;
    }
    const nextDia = normalizeSInput_(currentUser.branch, nextDate, state.nextDia && state.nextDia.trim() || codeForDate(nextDate), holidaySet);
    if (!nextDia) {
      alert("2일차 DIA를 입력해주세요");
      return;
    }
    const linkId = `${event.id}_${currentUser.id}_night_${date}`;
    const entryId1 = `${event.id}_${currentUser.id}_${date}`;
    const entryId2 = `${event.id}_${currentUser.id}_${nextDate}`;
    setSaving(true);
    Promise.all([window.LotteryAPI.apply(entryId1, {
      eventId: event.id,
      employeeId: currentUser.id,
      name: currentUser.name,
      branch: currentUser.branch,
      date,
      vacationType: state.type,
      dia,
      linkId
    }), window.LotteryAPI.apply(entryId2, {
      eventId: event.id,
      employeeId: currentUser.id,
      name: currentUser.name,
      branch: currentUser.branch,
      date: nextDate,
      vacationType: state.nextType,
      dia: nextDia,
      linkId
    })]).then(() => load()).catch(err => alert("응모 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };
  const handleCancelApply = entry => {
    const isLinked = !!entry.linkId;
    if (!confirm(isLinked ? `${entry.date} 야간 연계 응모(2일 모두)를 취소할까요?` : `${entry.date} 응모를 취소할까요?`)) return;
    setSaving(true);
    const paired = isLinked ? myEntries.find(en => en.linkId === entry.linkId && en.id !== entry.id) : null;
    const tasks = [window.LotteryAPI.cancelApply(entry.id)];
    if (paired) tasks.push(window.LotteryAPI.cancelApply(paired.id));
    Promise.all(tasks).then(() => load()).catch(err => alert("취소 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, "🎋 명절 연휴 추첨 응모"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "16px"
    }
  }, "날짜별로 원하는 휴가 종류·DIA를 선택해서 응모해주세요. 자리보다 응모자가 많으면 추첨해요."), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && openEvents.length === 0 && upcomingEvents.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "지금 응모 가능한 명절 이벤트가 없어요"), !loading && upcomingEvents.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 700,
      color: "#888",
      margin: "4px 0 8px"
    }
  }, "예정된 이벤트 (아직 응모 시작 전)"), upcomingEvents.map(event => /*#__PURE__*/React.createElement("div", {
    key: event.id,
    style: {
      ...modal.card,
      background: "#f2f2f2"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, event.year, "년 ", event.holidayName), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, event.applyStart, "부터 응모 가능 (대상: ", (event.dates || []).map(d => `${d.date}(${d.capacity}명)`).join(", "), ")"))))), !loading && openEvents.map(event => /*#__PURE__*/React.createElement("div", {
    key: event.id,
    style: {
      marginBottom: "20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "15px",
      fontWeight: 700,
      color: "#1b3a5c",
      marginBottom: "4px"
    }
  }, event.year, "년 ", event.holidayName), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "#888",
      marginBottom: "10px"
    }
  }, "응모 기간: ", event.applyStart, " ~ ", event.applyEnd), (event.dates || []).map(dateInfo => {
    const date = dateInfo.date;
    const entry = entryFor(event.id, date);
    const nextDateInfo = (event.dates || []).find(d => diffDays_(date, d.date) === 1);
    const canLinkNight = !entry && !!nextDateInfo && !entryFor(event.id, nextDateInfo.date);
    const st = formState[date] || {};
    return /*#__PURE__*/React.createElement("div", {
      key: date,
      style: {
        ...modal.card,
        flexDirection: "column",
        alignItems: "stretch"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        marginBottom: "6px"
      }
    }, date, " (", weekdayShort(date), ") · 정원 ", dateInfo.capacity, "명 · 응모 ", entryCountByDate[`${event.id}_${date}`] || 0, "명"), entry ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px"
      }
    }, entry.vacationType, " · ", entry.dia, entry.linkId && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#7a4fd1",
        fontWeight: 700
      }
    }, " · 🌙연계(2일)"), entry.result === "대기중" && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#e08a20"
      }
    }, " · 응모완료(추첨 대기)"), entry.result === "당첨" && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#1caa5c"
      }
    }, " · ✅당첨"), entry.result === "낙첨" && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#e02020"
      }
    }, " · 낙첨")), entry.result === "대기중" && /*#__PURE__*/React.createElement("button", {
      style: modal.smallCancelBtn,
      disabled: saving,
      onClick: () => handleCancelApply(entry)
    }, "응모취소")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "6px",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: 1,
        marginBottom: 0
      },
      value: formState[date] && formState[date].type || "",
      onChange: e => setFormState(prev => ({
        ...prev,
        [date]: {
          ...prev[date],
          type: e.target.value
        }
      }))
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "휴가종류"), CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))), /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: "0 0 90px",
        marginBottom: 0
      },
      value: formState[date] && formState[date].dia !== undefined ? formState[date].dia : codeForDate(date),
      onChange: e => setFormState(prev => ({
        ...prev,
        [date]: {
          ...prev[date],
          dia: e.target.value
        }
      }))
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번 선택"), branchCodesForDia.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, withSLabel(currentUser.branch, date, c, holidaySet)))), !st.linkNext && /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.approveBtn,
        flexShrink: 0
      },
      disabled: saving,
      onClick: () => handleApply(event, date)
    }, "응모")), canLinkNight && /*#__PURE__*/React.createElement("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginTop: "8px",
        fontSize: "12px",
        color: "#7a4fd1",
        fontWeight: 600
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: !!st.linkNext,
      onChange: e => setFormState(prev => ({
        ...prev,
        [date]: {
          ...prev[date],
          linkNext: e.target.checked
        }
      }))
    }), "🌙 다음날(", nextDateInfo.date, ")과 연계된 야간 신청 (이틀 모두 당첨돼야 확정, 하나만 당첨되지 않아요)"), canLinkNight && st.linkNext && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "6px",
        alignItems: "center",
        marginTop: "8px"
      }
    }, /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: 1,
        marginBottom: 0
      },
      value: st.nextType || "",
      onChange: e => setFormState(prev => ({
        ...prev,
        [date]: {
          ...prev[date],
          nextType: e.target.value
        }
      }))
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "2일차 휴가종류"), CAPACITY_TYPES.map(t => /*#__PURE__*/React.createElement("option", {
      key: t,
      value: t
    }, t))), /*#__PURE__*/React.createElement("select", {
      style: {
        ...styles.select,
        flex: "0 0 90px",
        marginBottom: 0
      },
      value: st.nextDia !== undefined ? st.nextDia : codeForDate(nextDateInfo.date),
      onChange: e => setFormState(prev => ({
        ...prev,
        [date]: {
          ...prev[date],
          nextDia: e.target.value
        }
      }))
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "2일차 교번"), branchCodesForDia.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, withSLabel(currentUser.branch, nextDateInfo.date, c, holidaySet)))), /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.approveBtn,
        flexShrink: 0,
        background: "#7a4fd1"
      },
      disabled: saving,
      onClick: () => handleApplyLinked(event, date, nextDateInfo.date)
    }, "2일 연계 응모"))));
  }))), !loading && myEntries.some(en => pastEvents.some(e => e.id === en.eventId)) && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 700,
      color: "#888",
      margin: "16px 0 8px"
    }
  }, "지난 응모 결과"), pastEvents.map(event => myEntries.filter(en => en.eventId === event.id).map(en => /*#__PURE__*/React.createElement("div", {
    key: en.id,
    style: modal.card
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, event.year, "년 ", event.holidayName, " · ", en.date), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, en.vacationType, " · ", en.dia, en.linkId && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#7a4fd1",
      fontWeight: 700
    }
  }, " · 🌙연계"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      color: en.result === "당첨" ? "#1caa5c" : en.result === "낙첨" ? "#e02020" : "#888"
    }
  }, en.result))))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 명절 연휴 추첨 - 관리자 패널                                          */
/* ------------------------------------------------------------------ */
function LotteryAdminPanel({
  branch,
  isSuperAdmin,
  onClose,
  employees,
  managers,
  holidaySet
}) {
  const [viewBranch, setViewBranch] = useState(branch); // 전체관리자만 전환 가능, 그 외엔 항상 본인 소속
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [entriesByEvent, setEntriesByEvent] = useState({}); // { [eventId]: entries[] }
  const [drawing, setDrawing] = useState(null); // 추첨 진행 중인 eventId

  // 새 이벤트 생성 폼 상태
  const [showNewForm, setShowNewForm] = useState(false);
  const [holidayName, setHolidayName] = useState("추석");
  const [year, setYear] = useState(new Date().getFullYear());
  const [newDates, setNewDates] = useState([]); // [{ date, capacity }]
  const [dateInput, setDateInput] = useState("");
  const [capacityInput, setCapacityInput] = useState("");
  const [applyStart, setApplyStart] = useState("");
  const [applyEnd, setApplyEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => {
    setLoading(true);
    waitForFirestore().then(() => window.LotteryAPI.listEvents()).then(list => {
      const branchList = (list || []).filter(e => e.branch === viewBranch);
      setEvents(branchList);
      return Promise.all(branchList.map(e => window.LotteryAPI.listEntriesForEvent(e.id).then(entries => [e.id, entries])));
    }).then(pairs => {
      const map = {};
      (pairs || []).forEach(([id, entries]) => {
        map[id] = entries;
      });
      setEntriesByEvent(map);
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [viewBranch]);
  const handleAddDate = () => {
    if (!dateInput) return;
    const cap = parseInt(capacityInput, 10);
    if (Number.isNaN(cap) || cap < 1) {
      alert("그 날짜에 뽑을 인원 수를 1 이상으로 입력해주세요");
      return;
    }
    if (newDates.some(d => d.date === dateInput)) {
      alert("이미 추가된 날짜예요");
      return;
    }
    setNewDates(prev => [...prev, {
      date: dateInput,
      capacity: cap
    }].sort((a, b) => a.date.localeCompare(b.date)));
    setDateInput("");
    setCapacityInput("");
  };
  const handleRemoveDate = d => {
    setNewDates(prev => prev.filter(x => x.date !== d));
  };
  const handleCreateEvent = () => {
    if (newDates.length === 0) {
      alert("대상 날짜를 하나 이상 추가해주세요");
      return;
    }
    if (!applyStart || !applyEnd) {
      alert("응모 시작일/마감일을 입력해주세요");
      return;
    }
    setSaving(true);
    window.LotteryAPI.createEvent({
      branch: viewBranch,
      holidayName,
      year: parseInt(year, 10),
      dates: newDates,
      applyStart,
      applyEnd
    }).then(() => {
      invalidateCachedList(LOTTERY_EVENTS_CACHE_KEY);
      setShowNewForm(false);
      setNewDates([]);
      setApplyStart("");
      setApplyEnd("");
      load();
    }).catch(err => alert("생성 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };
  const handleCloseApplication = event => {
    if (!confirm(`"${event.year}년 ${event.holidayName}" 응모를 지금 마감할까요?\n마감 후에는 추첨을 실행할 수 있어요.`)) return;
    window.LotteryAPI.updateEvent(event.id, {
      status: "마감"
    }).then(() => {
      invalidateCachedList(LOTTERY_EVENTS_CACHE_KEY);
      load();
    }).catch(err => alert("마감 실패: " + (err && err.message ? err.message : err)));
  };
  const handleRemoveEvent = event => {
    if (!confirm(`"${event.year}년 ${event.holidayName}" 이벤트를 완전히 삭제할까요?\n응모 기록도 함께 삭제되고, 되돌릴 수 없어요.`)) return;
    const entries = entriesByEvent[event.id] || [];
    Promise.all(entries.map(en => window.LotteryAPI.cancelApply(en.id))).then(() => window.LotteryAPI.removeEvent(event.id)).then(() => {
      invalidateCachedList(LOTTERY_EVENTS_CACHE_KEY);
      load();
    }).catch(err => alert("삭제 실패: " + (err && err.message ? err.message : err)));
  };

  // 추첨 실행 - 날짜별로 관리자가 지정한 인원(정원) 대비 응모자 수를 비교해서 정원보다 많으면 랜덤 추첨
  const handleRunDraw = async event => {
    if (!confirm(`"${event.year}년 ${event.holidayName}" 추첨을 실행할까요?\n실행하면 당첨자는 바로 실제 휴가로 등록되고, 되돌리기 어려워요.`)) return;
    setDrawing(event.id);
    try {
      const entries = (entriesByEvent[event.id] || []).filter(en => en.result === "대기중");

      // 1) 날짜별 현재 여유 인원(정원) 계산 + 그 날짜 응모자를 무작위 순서로 섞어서 대기열 구성
      const capacityLeft = {};
      const activeCapacityCountByDate = {};
      const candidatesByDate = {};
      const cursorByDate = {};
      const winnerSetByDate = {};
      for (const dateInfo of event.dates) {
        const date = dateInfo.date;
        const existing = await VacFacade.getByDate(date, event.branch);
        const activeExisting = existing.filter(v => v.status !== "취소됨");
        const activeCapacityCount = activeExisting.filter(v => isCapacityType(v.vacationType)).length;
        activeCapacityCountByDate[date] = activeCapacityCount;
        // 명절은 특수 상황이 많아서, 자동 계산 대신 관리자가 그 날짜에 직접 지정한 "추첨으로 뽑을 인원"을
        // 그대로 써요 - 그날 이미 채워진 일반 신청 인원과는 별개예요 (이중으로 빼면 안 돼요).
        capacityLeft[date] = dateInfo.capacity;
        candidatesByDate[date] = entries.filter(en => en.date === date).sort(() => Math.random() - 0.5);
        cursorByDate[date] = 0;
        winnerSetByDate[date] = new Set();
      }

      // 그 날짜 정원이 찰 때까지, 무작위로 섞인 대기열 순서대로 다음 사람을 당첨시켜요.
      const fillDate = date => {
        const candidates = candidatesByDate[date] || [];
        const winnerSet = winnerSetByDate[date];
        while (winnerSet.size < (capacityLeft[date] || 0) && cursorByDate[date] < candidates.length) {
          winnerSet.add(candidates[cursorByDate[date]].id);
          cursorByDate[date] += 1;
        }
      };

      // 2) 1차로 모든 날짜를 각자 독립적으로(그 날짜 응모자들끼리만 경쟁) 추첨
      for (const dateInfo of event.dates) fillDate(dateInfo.date);

      // 3) 야간(2일 연계) 응모 검증 - 두 날짜 다 당첨이면 그대로 확정, 한쪽만 당첨이면 둘 다 낙첨시키고
      //    그 자리는 해당 날짜의 다음 대기자에게 자동으로 넘어가요(fillDate 재호출). 승격된 사람이 또 다른
      //    연계의 절반이면 다시 검증하는 식으로, 더 이상 바뀌는 게 없을 때까지 반복해요.
      const pairs = [];
      const seenLinkIds = new Set();
      entries.forEach(en => {
        if (!en.linkId || seenLinkIds.has(en.linkId)) return;
        const partner = entries.find(e2 => e2.linkId === en.linkId && e2.id !== en.id);
        if (partner) {
          pairs.push({
            a: en,
            b: partner
          });
          seenLinkIds.add(en.linkId);
        }
      });
      let changed = true;
      while (changed) {
        changed = false;
        for (const pair of pairs) {
          const aWin = winnerSetByDate[pair.a.date].has(pair.a.id);
          const bWin = winnerSetByDate[pair.b.date].has(pair.b.id);
          if (aWin !== bWin) {
            // 한쪽만 당첨된 상태 - 야간연계는 하나만 당첨될 수 없으므로 둘 다 낙첨 처리
            if (aWin) winnerSetByDate[pair.a.date].delete(pair.a.id);
            if (bWin) winnerSetByDate[pair.b.date].delete(pair.b.id);
            changed = true;
          }
        }
        if (changed) {
          for (const dateInfo of event.dates) fillDate(dateInfo.date);
        }
      }

      // 4) 당첨자 순번(priority)은 날짜별로, 그 날짜에 최종 당첨된 사람들을 신청순서대로 매김
      const priorityByEntryId = {};
      for (const dateInfo of event.dates) {
        const date = dateInfo.date;
        const winners = (candidatesByDate[date] || []).filter(en => winnerSetByDate[date].has(en.id));
        const sorted = [...winners].sort((a, b) => {
          var _a$appliedAt, _a$appliedAt$toMillis, _b$appliedAt, _b$appliedAt$toMillis;
          return (((_a$appliedAt = a.appliedAt) === null || _a$appliedAt === void 0 || (_a$appliedAt$toMillis = _a$appliedAt.toMillis) === null || _a$appliedAt$toMillis === void 0 ? void 0 : _a$appliedAt$toMillis.call(_a$appliedAt)) || 0) - (((_b$appliedAt = b.appliedAt) === null || _b$appliedAt === void 0 || (_b$appliedAt$toMillis = _b$appliedAt.toMillis) === null || _b$appliedAt$toMillis === void 0 ? void 0 : _b$appliedAt$toMillis.call(_b$appliedAt)) || 0);
        });
        const base = activeCapacityCountByDate[date] || 0;
        sorted.forEach((en, idx) => {
          priorityByEntryId[en.id] = base + idx + 1;
        });
      }

      // 5) 결과 반영
      let totalWinners = 0;
      let totalLosers = 0;
      for (const en of entries) {
        const isWinner = winnerSetByDate[en.date].has(en.id);
        await window.LotteryAPI.updateEntry(en.id, {
          result: isWinner ? "당첨" : "낙첨"
        });
        if (isWinner) {
          await VacFacade.addOnce(en.branch, en.date, en.employeeId, {
            name: en.name,
            branch: en.branch,
            employeeId: en.employeeId,
            vacationType: en.vacationType,
            dia: en.dia,
            date: en.date,
            priority: priorityByEntryId[en.id]
          });
          totalWinners += 1;
        } else {
          totalLosers += 1;
        }
      }
      await window.LotteryAPI.updateEvent(event.id, {
        status: "추첨완료"
      });
      invalidateCachedList(LOTTERY_EVENTS_CACHE_KEY);
      alert(`추첨 완료! 당첨 ${totalWinners}건 · 낙첨 ${totalLosers}건`);
      load();
    } catch (err) {
      console.error(err);
      alert("추첨 중 오류: " + (err && err.message ? err.message : err));
    } finally {
      setDrawing(null);
    }
  };

  // 추첨완료 상태를 "마감"으로 되돌려요 - 당첨자로 등록됐던 휴가 기록은 취소하고,
  // 모든 응모 건을 다시 "대기중"으로 돌려서 재추첨할 수 있게 해요.
  const handleUndoDraw = async event => {
    if (!confirm(`"${event.year}년 ${event.holidayName}" 추첨 결과를 되돌릴까요?\n\n` + "당첨자로 등록됐던 휴가 기록은 취소되고, 모든 응모가 다시 대기중으로 돌아가요. 그 뒤 다시 추첨을 실행할 수 있어요.")) return;
    setDrawing(event.id);
    try {
      const entries = entriesByEvent[event.id] || [];
      for (const en of entries) {
        if (en.result === "당첨") {
          const docId = `${en.employeeId}_${en.date}`;
          await VacFacade.cancel(en.branch, en.date, docId).catch(err => console.error("당첨 취소된 휴가 기록 취소 실패:", err));
        }
        await window.LotteryAPI.updateEntry(en.id, {
          result: "대기중"
        });
      }
      await window.LotteryAPI.updateEvent(event.id, {
        status: "마감"
      });
      invalidateCachedList(LOTTERY_EVENTS_CACHE_KEY);
      alert("추첨 결과를 되돌렸어요. 다시 추첨을 실행할 수 있어요.");
      load();
    } catch (err) {
      console.error(err);
      alert("되돌리는 중 오류: " + (err && err.message ? err.message : err));
    } finally {
      setDrawing(null);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, "🎋 명절 연휴 추첨 관리"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "14px"
    }
  }, viewBranch, " 전용 화면이에요"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...adminStyles.approveBtn,
      width: "100%",
      padding: "12px",
      marginBottom: "16px"
    },
    onClick: () => setShowNewForm(v => !v)
  }, showNewForm ? "새 이벤트 만들기 닫기" : "+ 새 명절 응모 이벤트 만들기"), showNewForm && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "12px",
      padding: "14px",
      marginBottom: "18px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.formRow
  }, /*#__PURE__*/React.createElement("label", {
    style: modal.label
  }, "명절명"), /*#__PURE__*/React.createElement("select", {
    style: modal.input,
    value: holidayName,
    onChange: e => setHolidayName(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "추석"
  }, "추석"), /*#__PURE__*/React.createElement("option", {
    value: "설날"
  }, "설날"), /*#__PURE__*/React.createElement("option", {
    value: "기타"
  }, "기타"))), /*#__PURE__*/React.createElement("div", {
    style: modal.formRow
  }, /*#__PURE__*/React.createElement("label", {
    style: modal.label
  }, "연도"), /*#__PURE__*/React.createElement("input", {
    style: modal.input,
    type: "number",
    value: year,
    onChange: e => setYear(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    style: modal.formRow
  }, /*#__PURE__*/React.createElement("label", {
    style: modal.label
  }, "대상 날짜 + 뽑을 인원 추가"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "6px"
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...modal.input,
      flex: 1.4
    },
    type: "date",
    value: dateInput,
    onChange: e => setDateInput(e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    style: {
      ...modal.input,
      flex: "0 0 64px"
    },
    type: "number",
    placeholder: "인원",
    value: capacityInput,
    onChange: e => setCapacityInput(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    style: adminStyles.approveBtn,
    onClick: handleAddDate
  }, "추가")), newDates.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "8px",
      display: "flex",
      flexWrap: "wrap",
      gap: "6px"
    }
  }, newDates.map(d => /*#__PURE__*/React.createElement("span", {
    key: d.date,
    style: {
      background: "#eaf1ff",
      borderRadius: "999px",
      padding: "4px 10px",
      fontSize: "12px",
      display: "flex",
      alignItems: "center",
      gap: "4px"
    }
  }, d.date, " · ", d.capacity, "명", /*#__PURE__*/React.createElement("span", {
    style: {
      cursor: "pointer",
      color: "#e02020"
    },
    onClick: () => handleRemoveDate(d.date)
  }, "✕"))))), /*#__PURE__*/React.createElement("div", {
    style: modal.formRow
  }, /*#__PURE__*/React.createElement("label", {
    style: modal.label
  }, "응모 시작일"), /*#__PURE__*/React.createElement("input", {
    style: modal.input,
    type: "date",
    value: applyStart,
    onChange: e => setApplyStart(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    style: modal.formRow
  }, /*#__PURE__*/React.createElement("label", {
    style: modal.label
  }, "응모 마감일"), /*#__PURE__*/React.createElement("input", {
    style: modal.input,
    type: "date",
    value: applyEnd,
    onChange: e => setApplyEnd(e.target.value)
  })), /*#__PURE__*/React.createElement("button", {
    style: modal.addBtn,
    disabled: saving,
    onClick: handleCreateEvent
  }, saving ? "만드는 중..." : "이벤트 만들기")), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && events.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "등록된 이벤트가 없어요"), !loading && events.map(event => {
    const entries = entriesByEvent[event.id] || [];
    const byDate = {};
    entries.forEach(en => {
      if (!byDate[en.date]) byDate[en.date] = [];
      byDate[en.date].push(en);
    });
    return /*#__PURE__*/React.createElement("div", {
      key: event.id,
      style: {
        ...modal.card,
        flexDirection: "column",
        alignItems: "stretch"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "8px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: modal.name
    }, event.year, "년 ", event.holidayName), /*#__PURE__*/React.createElement("div", {
      style: modal.typeRow
    }, "응모 ", event.applyStart, "~", event.applyEnd, " · 상태: ", event.status)), /*#__PURE__*/React.createElement("button", {
      style: {
        padding: "5px 10px",
        borderRadius: "7px",
        border: "none",
        background: "#e02020",
        color: "#fff",
        fontWeight: 700,
        fontSize: "12px",
        whiteSpace: "nowrap",
        flexShrink: 0
      },
      onClick: () => handleRemoveEvent(event)
    }, "삭제")), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: "8px"
      }
    }, (event.dates || []).map(dateInfo => {
      const d = dateInfo.date;
      const dateEntries = byDate[d] || [];
      return /*#__PURE__*/React.createElement("div", {
        key: d,
        style: {
          marginTop: "6px"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: "12px",
          color: "#666"
        }
      }, d, " (정원 ", dateInfo.capacity, "명): 응모 ", dateEntries.length, "명", dateEntries.some(en => en.result !== "대기중") && ` (당첨 ${dateEntries.filter(en => en.result === "당첨").length}명)`), dateEntries.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          paddingLeft: "10px",
          marginTop: "2px"
        }
      }, dateEntries.map(en => /*#__PURE__*/React.createElement("div", {
        key: en.id,
        style: {
          fontSize: "11px",
          color: "#888"
        }
      }, "· ", en.name, " (", en.vacationType, "·", en.dia, ")", en.linkId && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#7a4fd1",
          fontWeight: 700
        }
      }, " 🌙연계"), en.result === "당첨" && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#1caa5c",
          fontWeight: 700
        }
      }, " 당첨"), en.result === "낙첨" && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#e02020"
        }
      }, " 낙첨"), en.result && en.result.startsWith("제외") && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#999"
        }
      }, " ", en.result), en.result === "대기중" && /*#__PURE__*/React.createElement("span", {
        style: {
          color: "#e08a20"
        }
      }, " 대기중")))));
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "6px",
        marginTop: "10px"
      }
    }, event.status === "응모중" && /*#__PURE__*/React.createElement("button", {
      style: adminStyles.resetBtn,
      onClick: () => handleCloseApplication(event)
    }, "응모 마감"), event.status === "마감" && /*#__PURE__*/React.createElement("button", {
      style: adminStyles.approveBtn,
      disabled: drawing === event.id,
      onClick: () => handleRunDraw(event)
    }, drawing === event.id ? "추첨 중..." : "🎲 추첨 실행"), event.status === "추첨완료" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: "12px",
        color: "#1caa5c",
        fontWeight: 700,
        alignSelf: "center"
      }
    }, "✅ 추첨 완료"), /*#__PURE__*/React.createElement("button", {
      style: {
        padding: "5px 10px",
        borderRadius: "7px",
        border: "1px dashed #e08a20",
        background: "#fff",
        color: "#e08a20",
        fontWeight: 700,
        fontSize: "12px"
      },
      disabled: drawing === event.id,
      onClick: () => handleUndoDraw(event)
    }, drawing === event.id ? "되돌리는 중..." : "↩️ 추첨 되돌리기"))));
  }), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 휴충당 신청 현황 (운용 전용 - 관리자 메뉴와 무관, isMidManager면 누구나) */
/* 휴가현황 달력과 완전히 분리된 별도 화면이지만, 디자인은 거의 동일하게 맞췄어요.       */
/* 날짜 칸에 신청 인원수(0 포함)를 배지로 보여주고, 클릭하면 그날 상세(휴가 상세창과      */
/* 비슷한 디자인)로 신청자 표를 보여주고, "+ 휴충당 지정"으로 대신기록과 같은 형태의      */
/* 폼(이름+충당교번 선택)으로 신청자 없이도 직접 등록할 수 있어요.                        */
/* ------------------------------------------------------------------ */
function HyuchungdangAdminPanel({
  branch,
  onClose,
  employees,
  managers,
  holidaySet
}) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-indexed
  const [allRequests, setAllRequests] = useState([]); // 이 소속의 전체 휴충당 신청(모든 상태)
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(null); // 상세 팝업용
  const [editingConfirmId, setEditingConfirmId] = useState(null); // 확인자 재수정 중인 신청 id
  const [showAssignForm, setShowAssignForm] = useState(false); // "+ 휴충당 지정" 폼 표시 여부
  const [assignTargetId, setAssignTargetId] = useState("");
  const [assignSubstituteDia, setAssignSubstituteDia] = useState("");
  const [assignSaving, setAssignSaving] = useState(false);

  // 월 달력 스와이프용 (휴가 달력과 동일한 방식)
  const touchStartX = useRef(null);
  const gridRef = useRef(null);
  const [slideX, setSlideX] = useState(0);
  const [slideTransition, setSlideTransition] = useState(false);

  // 날짜 상세 팝업 스와이프용 (휴가 상세창과 동일한 방식)
  const dayTouchStartX = useRef(null);
  const dayGridRef = useRef(null);
  const [daySlideX, setDaySlideX] = useState(0);
  const [daySlideTransition, setDaySlideTransition] = useState(false);

  // PC(넓은 화면)인지 감지 - 넓은 화면에서는 상세 팝업 바깥을 클릭해도 안 닫히게 하기 위함
  const [isWideScreen, setIsWideScreen] = useState(typeof window !== "undefined" && window.innerWidth >= 640);
  useEffect(() => {
    const onResize = () => setIsWideScreen(window.innerWidth >= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 충당교번 드롭다운/지정 대상자 계산용 - 그 소속의 교번틀 코드 목록·직원 목록
  const teamKey = REVERSE_TEAM_MAP[branch];
  const order = GYOBUN_ORDER[teamKey] || [];
  const branchEmployees = (employees || []).filter(e => e.branch === branch);
  const templateCodes = order.filter(c => branchEmployees.some(e => e.code === c));
  const otherCodes = [...new Set(branchEmployees.map(e => e.code))].filter(c => !templateCodes.includes(c));
  const branchCodes = [...templateCodes, ...otherCodes];

  // 확인자 드롭다운용 - 그 소속 운용 명단 (이름순)
  const branchManagerNames = (managers || []).filter(m => m.branch === branch).map(m => m.name).sort((a, b) => a.localeCompare(b, "ko"));
  const load = () => {
    setLoading(true);
    waitForFirestore().then(() => window.HyuchungdangAPI.listAllForBranch(branch)).then(data => {
      setAllRequests(data || []);
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);
  const changeMonth = delta => {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    if (m > 11) {
      m = 0;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  };
  const handleTouchStart = e => {
    touchStartX.current = e.touches[0].clientX;
    setSlideTransition(false);
  };
  const handleTouchMove = e => {
    if (touchStartX.current == null) return;
    setSlideX(e.touches[0].clientX - touchStartX.current);
  };
  const handleTouchEnd = () => {
    if (touchStartX.current == null) return;
    const dx = slideX;
    touchStartX.current = null;
    const width = gridRef.current ? gridRef.current.offsetWidth : 320;
    if (Math.abs(dx) > 60) {
      const dir = dx < 0 ? 1 : -1;
      setSlideTransition(true);
      setSlideX(-dir * width);
      setTimeout(() => {
        changeMonth(dir);
        setSlideTransition(false);
        setSlideX(dir * width);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setSlideTransition(true);
            setSlideX(0);
          });
        });
      }, 220);
    } else {
      setSlideTransition(true);
      setSlideX(0);
    }
  };

  // 상세 팝업 안에서 이전/다음 날짜로 이동 (화살표 버튼 + 스와이프 공용)
  const changeSelectedDate = delta => {
    if (!selectedDate) return;
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    const newYear = d.getFullYear();
    const newMonth = d.getMonth();
    const newDateStr = `${newYear}-${pad2(newMonth + 1)}-${pad2(d.getDate())}`;
    if (newYear !== viewYear || newMonth !== viewMonth) {
      setViewYear(newYear);
      setViewMonth(newMonth);
    }
    setSelectedDate(newDateStr);
    setShowAssignForm(false);
    setEditingConfirmId(null);
  };
  const handleDayTouchStart = e => {
    dayTouchStartX.current = e.touches[0].clientX;
    setDaySlideTransition(false);
  };
  const handleDayTouchMove = e => {
    if (dayTouchStartX.current == null) return;
    setDaySlideX(e.touches[0].clientX - dayTouchStartX.current);
  };
  const handleDayTouchEnd = () => {
    if (dayTouchStartX.current == null) return;
    dayTouchStartX.current = null;
    const dx = daySlideX;
    const width = dayGridRef.current ? dayGridRef.current.offsetWidth : 320;
    if (Math.abs(dx) > 60) {
      const dir = dx < 0 ? 1 : -1;
      setDaySlideTransition(true);
      setDaySlideX(-dir * width);
      setTimeout(() => {
        changeSelectedDate(dir);
        setDaySlideTransition(false);
        setDaySlideX(dir * width);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setDaySlideTransition(true);
            setDaySlideX(0);
          });
        });
      }, 220);
    } else {
      setDaySlideTransition(true);
      setDaySlideX(0);
    }
  };

  // 신청중인 것만 실제 "달력에 보이는 신청"으로 취급 (취소된 건 집계·목록 어디에도 안 잡힘)
  const activeRequests = allRequests.filter(r => r.status === "신청중");
  const monthMap = {};
  activeRequests.forEach(r => {
    if (!monthMap[r.date]) monthMap[r.date] = [];
    monthMap[r.date].push(r);
  });

  // 특정 직원의 특정 날짜 실제 교번 계산 (운용이 직접 지정할 때, 원래 교번을 자동으로 채워주기 위함)
  const codeForEmployeeOnDate = (empId, dateStr) => {
    const emp = branchEmployees.find(e => e.id === empId);
    if (!emp || !BASE_DATE || !order.length) return "";
    const bc = baseCodeForPersonOnDate_(employees, emp.name, emp.branch, dateStr, emp.baseCode);
    if (!bc) return "";
    const offset = diffDays_(BASE_DATE, dateStr);
    return shiftCodeByDays_(order, bc, offset);
  };

  // 그 직원이 올해 확정(충당교번+확인까지 마침)한 휴충당 총 건수
  const confirmedCountForEmployee = (empId, dateStr) => {
    const year = dateStr.slice(0, 4);
    return allRequests.filter(r => r.employeeId === empId && r.date.startsWith(year) && r.status !== "취소됨" && r.confirmedBy).length;
  };

  // 목록 안의 특정 신청 건을 부분 수정 (충당교번/확인자) - 로컬 상태도 같이 갱신
  const patchRequest = (r, patch) => {
    window.HyuchungdangAPI.update(r.id, patch).then(() => {
      setAllRequests(prev => prev.map(x => x.id === r.id ? {
        ...x,
        ...patch
      } : x));
    }).catch(err => alert("수정 실패: " + (err && err.message ? err.message : err)));
  };

  // 예전부터 있던 신청 건 중 신청 시각(requestedAt)이 아예 없는 것만, 지금 시각으로 한 번 채워줘요.
  // 앞으로 새로 들어오는 신청은 이미 자동으로 시각이 기록되니, 이건 옛날 건 보완용 일회성 도구예요.
  const handleFillMissingTimestamps = () => {
    const targets = (allRequests || []).filter(r => !r.requestedAt);
    if (targets.length === 0) {
      alert("시각이 비어있는 신청 건이 없어요.");
      return;
    }
    if (!confirm(`시각이 없는 신청 ${targets.length}건에 지금 시각을 채워넣을까요?`)) return;
    Promise.all(targets.map(r => window.HyuchungdangAPI.update(r.id, {
      requestedAt: new Date()
    }))).then(() => {
      alert(`${targets.length}건에 시각을 채웠어요.`);
      load();
    }).catch(err => alert("처리 실패: " + (err && err.message ? err.message : err)));
  };
  const handleConfirmSelect = (r, name) => {
    if (!r.substituteDia) {
      alert("충당교번을 먼저 선택해주세요");
      return;
    }
    patchRequest(r, {
      confirmedBy: name,
      notified: false
    });
    setEditingConfirmId(null);
  };

  // 운용이 "확정 취소" - 신청 자체는 그대로 두고, 충당교번/확인만 다시 빈 상태로 되돌려요.
  // (막판 사정 변경 대응용. 신청을 취소하는 게 아니라서 기관사 본인 목록엔 아무 변화 없어요 -
  // 여전히 "신청중"으로 그대로 보여요.)
  const handleCancelByAdmin = r => {
    if (!confirm(`${r.name}님의 ${r.date} 휴충당 확정을 취소할까요? (신청 자체는 유지돼요)`)) return;
    patchRequest(r, {
      substituteDia: "",
      confirmedBy: ""
    });
  };

  // "+ 휴충당 지정"으로 운용이 직접 등록한 건 - 사람을 잘못 골랐거나 할 때 완전히 지울 수 있어요.
  // (신청자 본인이 낸 건 아니라서 흔적을 남길 필요 없이 그냥 삭제해요)
  const handleRemoveAssigned = r => {
    if (!confirm(`${r.name}님으로 지정한 ${r.date} 휴충당을 완전히 삭제할까요?`)) return;
    window.HyuchungdangAPI.remove(r.id).then(() => {
      setAllRequests(prev => prev.filter(x => x.id !== r.id));
    }).catch(err => alert("삭제 실패: " + (err && err.message ? err.message : err)));
  };
  const openAssignForm = () => {
    setAssignTargetId("");
    setAssignSubstituteDia("");
    setShowAssignForm(true);
  };
  const handleAssign = () => {
    const emp = branchEmployees.find(e => e.id === assignTargetId);
    if (!emp) {
      alert("대상자를 선택해주세요");
      return;
    }
    if (activeRequests.some(r => r.employeeId === emp.id && r.date === selectedDate)) {
      alert("이미 그 날짜에 신청(또는 지정)된 기록이 있어요");
      return;
    }
    setAssignSaving(true);
    const id = `${emp.id}_${selectedDate}`;
    const originalDia = codeForEmployeeOnDate(emp.id, selectedDate);
    window.HyuchungdangAPI.request(id, {
      employeeId: emp.id,
      name: emp.name,
      branch,
      date: selectedDate,
      originalDia,
      assignedByAdmin: true,
      ...(assignSubstituteDia ? {
        substituteDia: assignSubstituteDia
      } : {})
    }).then(() => {
      setAllRequests(prev => [...prev, {
        id,
        employeeId: emp.id,
        name: emp.name,
        branch,
        date: selectedDate,
        originalDia,
        substituteDia: assignSubstituteDia || undefined,
        assignedByAdmin: true,
        status: "신청중"
      }]);
      setShowAssignForm(false);
      setAssignTargetId("");
      setAssignSubstituteDia("");
    }).catch(err => alert("지정 실패: " + (err && err.message ? err.message : err))).finally(() => setAssignSaving(false));
  };
  const closeDetail = () => {
    setSelectedDate(null);
    setShowAssignForm(false);
    setEditingConfirmId(null);
  };
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const todayKey = todayStr();
  const selectedRows = selectedDate ? sortHyuchungdangForDisplay(monthMap[selectedDate] || []) : [];
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f7f4ee",
      width: "100%",
      maxWidth: "480px",
      margin: "0 auto",
      minHeight: "100vh"
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.header
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.headerTop
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.userName
  }, "🔁 휴충당 신청 현황"), /*#__PURE__*/React.createElement("div", {
    style: cal.headerBtnRow
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...adminStyles.adminBtn,
      fontSize: "10px"
    },
    onClick: handleFillMissingTimestamps,
    title: "신청 시각이 비어있는 옛날 건에만 지금 시각을 채워요"
  }, "⏱️ 시각 채우기"), /*#__PURE__*/React.createElement("button", {
    style: adminStyles.adminBtn,
    onClick: onClose
  }, "닫기"))), /*#__PURE__*/React.createElement("div", {
    style: cal.navRow
  }, /*#__PURE__*/React.createElement("button", {
    style: cal.navBtn,
    onClick: () => changeMonth(-1)
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cal.monthTitle
  }, viewYear, "년 ", viewMonth + 1, "월"), (viewYear !== now.getFullYear() || viewMonth !== now.getMonth()) && /*#__PURE__*/React.createElement("button", {
    style: {
      border: "1px solid rgba(255,255,255,0.4)",
      background: "transparent",
      color: "#cfe0ff",
      fontSize: "11px",
      fontWeight: 700,
      padding: "2px 8px",
      borderRadius: "6px"
    },
    onClick: () => {
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth());
    }
  }, "오늘로")), /*#__PURE__*/React.createElement("button", {
    style: cal.navBtn,
    onClick: () => changeMonth(1)
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: cal.weekRow
  }, WEEKDAYS.map((w, i) => /*#__PURE__*/React.createElement("div", {
    key: w,
    style: {
      color: i === 0 ? "#ff8a80" : i === 6 ? "#8ecdff" : "#c9d4de"
    }
  }, w))), /*#__PURE__*/React.createElement("div", {
    style: cal.railDivider
  })), loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "24px"
    }
  }, "불러오는 중...") : /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: "hidden",
      width: "100%"
    },
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd
  }, /*#__PURE__*/React.createElement("div", {
    ref: gridRef,
    style: {
      ...cal.grid,
      transform: `translateX(${slideX}px)`,
      transition: slideTransition ? "transform 220ms ease" : "none"
    }
  }, cells.map((d, i) => {
    if (d === null) return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: cal.emptyCell
    });
    const key = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(d)}`;
    const dayRequests = monthMap[key] || [];
    const confirmedList = dayRequests.filter(r => r.confirmedBy);
    const pendingList = dayRequests.filter(r => !r.confirmedBy);
    const isConfirmedState = key < todayKey || confirmedList.length > 0;
    const displayCount = isConfirmedState ? confirmedList.length : pendingList.length;
    const badgeColor = isConfirmedState ? "#1caa5c" : displayCount > 0 ? "#e08a20" : "#ccc";
    const dayType = getDayType(key, holidaySet);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: cal.dayCell(key === todayKey),
      onClick: () => setSelectedDate(key)
    }, /*#__PURE__*/React.createElement("div", {
      style: cal.dayNum(dayType)
    }, d), /*#__PURE__*/React.createElement("div", {
      style: cal.dayDivider
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "11px",
        color: "#aaa"
      }
    }, isConfirmedState ? "확정" : "신청"), /*#__PURE__*/React.createElement("div", {
      style: cal.dayBadge(badgeColor)
    }, displayCount));
  })))), selectedDate && (() => {
    const headerColor = dateHeaderColor(selectedDate, holidaySet);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.overlay,
        alignItems: "safe center",
        justifyContent: "center",
        zIndex: 200
      },
      onClick: e => {
        e.stopPropagation();
        if (!isWideScreen) closeDetail();
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.sheet,
        maxWidth: "480px"
      },
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "4px"
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "6px 10px",
        fontSize: "14px"
      },
      onClick: () => changeSelectedDate(-1)
    }, "‹"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.dateTitle,
        marginBottom: 0,
        color: headerColor
      }
    }, formatDateHeader(selectedDate)), /*#__PURE__*/React.createElement("button", {
      style: {
        ...adminStyles.adminBtn,
        padding: "6px 10px",
        fontSize: "14px"
      },
      onClick: () => changeSelectedDate(1)
    }, "›")), /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "hidden"
      },
      onTouchStart: handleDayTouchStart,
      onTouchMove: handleDayTouchMove,
      onTouchEnd: handleDayTouchEnd
    }, /*#__PURE__*/React.createElement("div", {
      ref: dayGridRef,
      style: {
        transform: `translateX(${daySlideX}px)`,
        transition: daySlideTransition ? "transform 220ms ease" : "none"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: modal.countText
    }, "신청중 ", selectedRows.length, "명"), selectedRows.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: "#aaa",
        padding: "16px 0"
      }
    }, "신청자가 없어요") : /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "auto",
        marginBottom: "12px"
      }
    }, /*#__PURE__*/React.createElement("table", {
      style: {
        width: "max-content",
        minWidth: "100%",
        borderCollapse: "collapse",
        fontSize: "13px"
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
      style: {
        borderBottom: "2px solid #333"
      }
    }, /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "#"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...tbl.th,
        textAlign: "left"
      }
    }, "이름"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "교번"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "충당교번"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "확인"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }, "올해 확정"), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }), /*#__PURE__*/React.createElement("th", {
      style: tbl.th
    }))), /*#__PURE__*/React.createElement("tbody", null, selectedRows.map((r, idx) => /*#__PURE__*/React.createElement("tr", {
      key: r.id,
      style: {
        borderBottom: "1px solid #eee"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, idx + 1), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tbl.td,
        textAlign: "left",
        fontWeight: 700
      }
    }, r.name, r.requestedAt && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "11px",
        fontWeight: 400,
        color: "#888"
      }
    }, formatEntryTime(r.requestedAt))), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tbl.td,
        fontWeight: 700,
        color: ["휴1", "휴5", "휴10", "휴13"].includes(r.originalDia) ? "#e02020" : "#1b3a5c"
      }
    }, r.originalDia || "-"), /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, /*#__PURE__*/React.createElement("select", {
      value: r.substituteDia || "",
      onChange: e => patchRequest(r, {
        substituteDia: e.target.value
      }),
      style: {
        fontSize: "12px",
        padding: "2px",
        maxWidth: "76px"
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "선택"), branchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, c)))), /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, r.confirmedBy ? editingConfirmId === r.id ? /*#__PURE__*/React.createElement("select", {
      value: r.confirmedBy,
      onChange: e => {
        if (e.target.value) handleConfirmSelect(r, e.target.value);
      },
      onBlur: () => setEditingConfirmId(null),
      style: {
        fontSize: "11px",
        padding: "2px",
        maxWidth: "80px"
      },
      autoFocus: true
    }, branchManagerNames.map(name => /*#__PURE__*/React.createElement("option", {
      key: name,
      value: name
    }, name))) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#1caa5c",
        cursor: "pointer"
      },
      onClick: () => setEditingConfirmId(r.id)
    }, "✅", r.confirmedBy, " ✏️") : /*#__PURE__*/React.createElement("select", {
      value: "",
      onChange: e => {
        if (e.target.value) handleConfirmSelect(r, e.target.value);
      },
      style: {
        fontSize: "11px",
        padding: "2px",
        maxWidth: "80px"
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "확인"), branchManagerNames.map(name => /*#__PURE__*/React.createElement("option", {
      key: name,
      value: name
    }, name)))), /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, confirmedCountForEmployee(r.employeeId, r.date), "건"), /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, r.confirmedBy && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#e02020",
        textDecoration: "underline",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: () => handleCancelByAdmin(r)
    }, "확정취소")), /*#__PURE__*/React.createElement("td", {
      style: tbl.td
    }, r.assignedByAdmin && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#999",
        textDecoration: "underline",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: () => handleRemoveAssigned(r)
    }, "삭제"))))))), !showAssignForm ? /*#__PURE__*/React.createElement("button", {
      style: {
        ...modal.addBtn,
        background: "#e08a20"
      },
      onClick: openAssignForm
    }, "+ 휴충당 지정") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.dateTitle,
        fontSize: "16px",
        marginTop: "10px"
      }
    }, formatDateHeader(selectedDate), " 휴충당 지정"), /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.countText,
        marginBottom: "18px"
      }
    }, "운용이 직접 지정하는 기록이에요"), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "대상자"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: assignTargetId,
      onChange: e => setAssignTargetId(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "이름 선택"), [...branchEmployees].map(e => ({
      ...e,
      restCode: codeForEmployeeOnDate(e.id, selectedDate)
    })).filter(e => String(e.restCode || "").startsWith("휴")).sort((a, b) => {
      const na = parseInt(String(a.restCode).replace(/[^0-9]/g, ""), 10) || 0;
      const nb = parseInt(String(b.restCode).replace(/[^0-9]/g, ""), 10) || 0;
      return na - nb;
    }).map(e => {
      const isNightEligible = ["휴1", "휴5", "휴10", "휴13"].includes(e.restCode);
      return /*#__PURE__*/React.createElement("option", {
        key: e.id,
        value: e.id
      }, isNightEligible ? "⭐ " : "", e.name, " (", e.restCode, ")");
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "#888",
        marginTop: "4px"
      }
    }, "그날 교번이 \"휴\"인 사람만 목록에 나와요 · ⭐ 표시는 야간 근무 휴충당이 가능한 휴1·5·10·13이에요")), /*#__PURE__*/React.createElement("div", {
      style: modal.formRow
    }, /*#__PURE__*/React.createElement("label", {
      style: modal.label
    }, "충당교번"), /*#__PURE__*/React.createElement("select", {
      style: modal.input,
      value: assignSubstituteDia,
      onChange: e => setAssignSubstituteDia(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "교번을 선택해주세요"), branchCodes.map(c => /*#__PURE__*/React.createElement("option", {
      key: c,
      value: c
    }, c)))), /*#__PURE__*/React.createElement("button", {
      style: modal.addBtn,
      onClick: handleAssign,
      disabled: assignSaving
    }, assignSaving ? "저장 중..." : "저장"), /*#__PURE__*/React.createElement("button", {
      style: modal.closeBtn,
      onClick: () => {
        setShowAssignForm(false);
        setAssignTargetId("");
        setAssignSubstituteDia("");
      }
    }, "취소")))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "#888",
        margin: "10px 0"
      }
    }, "신청자가 없어도, 운용이 기관사와 협의 후 직접 지정할 수 있어요."), /*#__PURE__*/React.createElement("button", {
      style: modal.closeBtn,
      onClick: closeDetail
    }, "닫기")));
  })());
}
function AdminPanel({
  branch,
  isSuperAdmin,
  onClose,
  employees,
  managers
}) {
  const [tab, setTab] = useState("pending"); // "pending" | "approved"
  const [viewBranch, setViewBranch] = useState(branch); // 전체관리자만 전환 가능, 그 외엔 항상 본인 소속
  const [pending, setPending] = useState([]);
  const [approved, setApproved] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    waitForFirestore().then(() => Promise.all([window.ApprovalAPI.listPending(), window.ApprovalAPI.listApproved()])).then(([pendingList, approvedList]) => {
      setPending((pendingList || []).filter(p => p.branch === viewBranch));
      setApproved((approvedList || []).filter(p => p.branch === viewBranch));
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [viewBranch]);
  const handleAction = (id, status) => {
    window.ApprovalAPI.setStatus(id, status).then(() => {
      setPending(prev => prev.filter(p => p.id !== id));
    });
  };
  const handleResetDevice = p => {
    if (!confirm(`${p.name} (${p.branch})님의 승인 기록을 삭제할까요?\n삭제 후 다시 등록하면 재승인을 받아야 해요.`)) return;
    window.ApprovalAPI.reset(p.id).then(() => {
      setApproved(prev => prev.filter(a => a.id !== p.id));
    });
  };
  const handleDeleteAll = () => {
    if (!confirm("테스트용으로 쌓인 승인 기록을 전부 삭제할까요?\n(대기중·승인됨 전부 지워져서, 다들 처음부터 자유롭게 다시 등록해볼 수 있어요)")) return;
    window.ApprovalAPI.deleteAll().then(count => {
      alert(`승인 기록 ${count}건을 삭제했어요.`);
      load(); // 서버에서 다시 불러와서 실제로 지워졌는지 화면에 확인
    }).catch(err => {
      console.error(err);
      alert("삭제 실패: " + (err && err.message ? err.message : err));
    });
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.dateTitle,
      marginBottom: "10px"
    }
  }, viewBranch, " 승인 관리"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "6px",
      marginBottom: "14px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: tab === "pending" ? adminStyles.tabBtnActive : adminStyles.tabBtn,
    onClick: () => setTab("pending")
  }, "승인 대기 (", pending.length, ")"), /*#__PURE__*/React.createElement("button", {
    style: tab === "approved" ? adminStyles.tabBtnActive : adminStyles.tabBtn,
    onClick: () => setTab("approved")
  }, "승인된 사용자")), TEST_MODE && /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e02020",
      color: "#e02020",
      marginBottom: "14px",
      padding: "10px"
    },
    onClick: handleDeleteAll
  }, "🔄 (테스트용) 승인 기록 전체 삭제"), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && tab === "pending" && /*#__PURE__*/React.createElement(React.Fragment, null, pending.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "대기중인 요청이 없어요"), pending.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: modal.card
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, p.branch, " · ", p.id)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "8px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: adminStyles.approveBtn,
    onClick: () => handleAction(p.id, "approved")
  }, "승인"), /*#__PURE__*/React.createElement("button", {
    style: adminStyles.rejectBtn,
    onClick: () => handleAction(p.id, "rejected")
  }, "거절"))))), !loading && tab === "approved" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "10px"
    }
  }, "폰을 바꾼 사람이나, 다시 등록시켜야 하는 사람은 \"기록삭제\"를 눌러주세요"), approved.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "승인된 사용자가 없어요"), approved.map(p => {
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      style: {
        ...modal.card,
        flexDirection: "column",
        alignItems: "stretch"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: modal.name
    }, p.name), /*#__PURE__*/React.createElement("div", {
      style: modal.typeRow
    }, p.branch, " · ", p.id)), /*#__PURE__*/React.createElement("button", {
      style: adminStyles.resetBtn,
      onClick: () => handleResetDevice(p)
    }, "기록삭제")));
  })), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 교번 변경 예약 패널 (관리자 전용)                                      */
/* 시트는 건드리지 않고, "이 날짜부터 두 사람 자리 맞교환"을 Firestore에 예약해요. */
/* ------------------------------------------------------------------ */
function RosterChangePanel({
  branch,
  isSuperAdmin,
  onClose,
  employees,
  currentUser
}) {
  const today = koreaTodayStr();
  const firstOfNextMonth = (() => {
    const [y, m] = today.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${pad2(nm)}-01`;
  })();
  const [viewBranch, setViewBranch] = useState(branch);
  const [items, setItems] = useState(ROSTER_CHANGES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nameA, setNameA] = useState("");
  const [nameB, setNameB] = useState("");
  const [date, setDate] = useState(firstOfNextMonth);
  const [listTab, setListTab] = useState("pending"); // "pending" 적용 전 | "needSheet" 시트 수정 필요 | "done" 완료
  const supported = !!(window.SystemAPI && window.SystemAPI.getRosterChanges && window.SystemAPI.saveRosterChanges);
  const sourceList = LAST_RAW_EMPLOYEES && LAST_RAW_EMPLOYEES.length ? LAST_RAW_EMPLOYEES : employees || [];

  // 시트에 이미 새 주인 이름이 적혀 있는지 (교번앱 반영 여부 표시용)
  const sheetNameOf = slotId => {
    const e = (LAST_RAW_EMPLOYEES || []).find(x => x.id === slotId);
    return e ? e.name : null;
  };
  const groupReflected = group => group.every(c => sheetNameOf(c.slotId) === c.newName);
  const saveAll = next => window.SystemAPI.saveRosterChanges(next).then(() => {
    setRosterChanges_(next);
    setItems(next);
  });
  useEffect(() => {
    if (!supported) {
      setLoading(false);
      return;
    }
    waitForFirestore().then(() => window.SystemAPI.getRosterChanges()).then(list => {
      // 시트에도 반영되고 적용일이 31일 넘게 지난 예약은 더 이상 필요 없어서 자동 정리해요
      // (지난 날짜 대신기록·교번 표시를 위해 한 달은 남겨둬요)
      const cutoff = shiftDateStr_(today, -31);
      const groups = {};
      (list || []).forEach(c => {
        (groups[c.groupId] = groups[c.groupId] || []).push(c);
      });
      const staleIds = Object.keys(groups).filter(g => groups[g][0].date < cutoff && groupReflected(groups[g]));
      if (staleIds.length) {
        const next = list.filter(c => !staleIds.includes(c.groupId));
        return saveAll(next);
      }
      setRosterChanges_(list || []);
      setItems(list || []);
    }).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  }, []);

  // 적용일 전날 기준 명단 - 그 시점에 누가 어느 자리에 있는지
  const eveList = employeesOnDate_(sourceList, shiftDateStr_(date || today, -1)).filter(e => e.branch === viewBranch);
  const names = [...new Set(eveList.map(e => e.name))].sort((a, b) => a.localeCompare(b, "ko"));
  const teamKey = REVERSE_TEAM_MAP[viewBranch];
  const order = GYOBUN_ORDER[teamKey] || [];
  const codeOn = (baseCode, dateStr) => !BASE_DATE || !baseCode || !order.length ? "" : shiftCodeByDays_(order, baseCode, diffDays_(BASE_DATE, dateStr));
  const slotA = eveList.find(e => e.name === nameA);
  const slotB = eveList.find(e => e.name === nameB);
  const busySlot = slotId => ROSTER_CHANGES.some(c => c.branch === viewBranch && c.slotId === slotId && c.date >= today);
  const handleSave = () => {
    if (!nameA || !nameB) return alert("바꿀 두 사람을 선택해주세요.");
    if (nameA === nameB) return alert("서로 다른 두 사람을 선택해주세요.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return alert("적용일을 선택해주세요.");
    if (date <= today) return alert("적용일은 내일 이후로 선택해주세요.");
    if (!slotA || !slotB) return alert("명단에서 자리를 찾지 못했어요. 새로고침 후 다시 시도해주세요.");
    if (!confirm(`${date}부터 ${nameA} ↔ ${nameB} 자리를 맞바꿀까요?\n\n${date} 교번: ${nameA} ${codeOn(slotA.baseCode, date)}→${codeOn(slotB.baseCode, date)}, ${nameB} ${codeOn(slotB.baseCode, date)}→${codeOn(slotA.baseCode, date)}`)) return;
    setSaving(true);
    waitForFirestore().then(() => window.SystemAPI.getRosterChanges()).then(latest => {
      setRosterChanges_(latest || []);
      if (busySlot(slotA.id) || busySlot(slotB.id)) {
        throw new Error("두 사람 중 이미 적용 전인 예약이 있는 자리가 있어요. 기존 예약을 먼저 취소해주세요.");
      }
      const groupId = `rc_${Date.now()}`;
      const meta = {
        groupId,
        branch: viewBranch,
        date,
        createdBy: currentUser && currentUser.name || "",
        createdAt: Date.now()
      };
      const next = [...(latest || []), {
        ...meta,
        id: groupId + "_a",
        slotId: slotA.id,
        oldName: nameA,
        newName: nameB
      }, {
        ...meta,
        id: groupId + "_b",
        slotId: slotB.id,
        oldName: nameB,
        newName: nameA
      }];
      return saveAll(next);
    }).then(() => {
      setNameA("");
      setNameB("");
      alert("예약했어요. 휴가앱에서는 적용일부터 새 자리 교번으로 계산돼요.\n(교번앱은 시트 이름을 바꿔야 반영돼요)");
    }).catch(err => alert(err && err.message ? err.message : String(err))).finally(() => setSaving(false));
  };
  const handleCancel = groupId => {
    if (!confirm("이 예약을 취소할까요?")) return;
    setSaving(true);
    waitForFirestore().then(() => window.SystemAPI.getRosterChanges()).then(latest => saveAll((latest || []).filter(c => c.groupId !== groupId))).catch(err => alert("취소 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };
  const groups = {};
  items.filter(c => c.branch === viewBranch).forEach(c => {
    (groups[c.groupId] = groups[c.groupId] || []).push(c);
  });
  const groupList = Object.values(groups).sort((a, b) => a[0].date < b[0].date ? 1 : -1);
  // 적용 전·시트 미반영은 기본으로 보이고, 시트 반영까지 끝난 건 "지난 내역"으로 접어둬요
  const stageOf = group => group[0].date > today ? "pending" : groupReflected(group) ? "done" : "needSheet";
  const tabGroups = {
    pending: groupList.filter(g => stageOf(g) === "pending"),
    needSheet: groupList.filter(g => stageOf(g) === "needSheet"),
    done: groupList.filter(g => stageOf(g) === "done")
  };
  const tabInfo = {
    pending: {
      label: "적용 전",
      empty: "적용을 기다리는 예약이 없어요",
      help: "적용일이 아직 안 된 예약이에요. 휴가앱은 적용일부터 새 자리로 계산해요."
    },
    needSheet: {
      label: "시트 수정 필요",
      empty: "시트를 고칠 예약이 없어요",
      help: "휴가앱은 이미 새 자리로 동작 중이에요. 교번앱도 맞추려면 직원목록 시트에서 두 사람 이름을 바꿔주세요. 바꾸면 자동으로 '완료'로 넘어가요."
    },
    done: {
      label: "완료",
      empty: "완료된 예약이 없어요",
      help: "시트까지 반영된 예약이에요. 적용일 31일 뒤 자동으로 정리돼요."
    }
  };
  const renderGroup = group => {
    const a = group.find(c => c.id.endsWith("_a")) || group[0];
    const sa = group.find(c => c.id.endsWith("_a"));
    const sb = group.find(c => c.id.endsWith("_b"));
    return /*#__PURE__*/React.createElement("div", {
      key: a.groupId,
      style: modal.card
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: modal.name
    }, a.oldName, " ↔ ", a.newName), /*#__PURE__*/React.createElement("div", {
      style: modal.typeRow
    }, a.date, "부터"), listTab === "needSheet" && sa && sb && /*#__PURE__*/React.createElement("div", {
      style: {
        ...modal.typeRow,
        color: "#e08a20"
      }
    }, "시트: ", sa.slotId, " → ", sa.newName, ", ", sb.slotId, " → ", sb.newName)), /*#__PURE__*/React.createElement("button", {
      style: adminStyles.rejectBtn,
      disabled: saving,
      onClick: () => handleCancel(a.groupId)
    }, "취소"));
  };
  const selectStyle = {
    ...styles.select,
    maxWidth: "none",
    padding: "11px",
    fontSize: "15px"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.dateTitle,
      marginBottom: "10px"
    }
  }, "🔀 ", viewBranch, " 교번 변경 예약"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "12px",
      lineHeight: 1.5
    }
  }, "적용일 전에는 원래 자리, 적용일부터는 새 자리 교번으로 휴가 신청·정원이 계산돼요. 시트는 그대로라 교번앱은 시트 이름을 바꿔야 반영돼요."), !supported && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#e02020",
      fontSize: "13px",
      padding: "10px 0"
    }
  }, "이 버전의 index.html은 교번 변경 예약을 지원하지 않아요. index.html을 최신으로 올려주세요."), supported && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "12px",
      padding: "12px",
      marginBottom: "14px"
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: styles.fieldLabel
  }, "적용일"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: {
      ...modal.input,
      marginBottom: "10px"
    },
    value: date,
    min: shiftDateStr_(today, 1),
    onChange: e => setDate(e.target.value)
  }), /*#__PURE__*/React.createElement("label", {
    style: styles.fieldLabel
  }, "바꿀 두 사람"), /*#__PURE__*/React.createElement("select", {
    style: selectStyle,
    value: nameA,
    onChange: e => setNameA(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "첫 번째 사람 선택"), names.map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#888",
      fontSize: "13px"
    }
  }, "↕ 자리 맞교환"), /*#__PURE__*/React.createElement("select", {
    style: selectStyle,
    value: nameB,
    onChange: e => setNameB(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "두 번째 사람 선택"), names.filter(n => n !== nameA).map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n))), slotA && slotB && nameA !== nameB && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#1b3a5c",
      margin: "8px 0",
      lineHeight: 1.6
    }
  }, date, " 교번 미리보기", /*#__PURE__*/React.createElement("br", null), "· ", nameA, ": ", codeOn(slotA.baseCode, date), " → ", /*#__PURE__*/React.createElement("strong", null, codeOn(slotB.baseCode, date)), /*#__PURE__*/React.createElement("br", null), "· ", nameB, ": ", codeOn(slotB.baseCode, date), " → ", /*#__PURE__*/React.createElement("strong", null, codeOn(slotA.baseCode, date))), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      marginTop: "6px",
      opacity: saving ? 0.6 : 1
    },
    disabled: saving,
    onClick: handleSave
  }, saving ? "저장 중..." : "예약 저장")), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && supported && groupList.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "12px 0"
    }
  }, "예약된 교번 변경이 없어요"), !loading && groupList.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "6px",
      margin: "4px 0 10px"
    }
  }, ["pending", "needSheet", "done"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    style: {
      ...(listTab === t ? adminStyles.tabBtnActive : adminStyles.tabBtn),
      ...(t === "needSheet" && tabGroups.needSheet.length > 0 && listTab !== t ? {
        color: "#e08a20",
        borderColor: "#e08a20"
      } : {})
    },
    onClick: () => setListTab(t)
  }, tabInfo[t].label, " (", tabGroups[t].length, ")"))), !loading && groupList.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      margin: "0 0 8px",
      lineHeight: 1.5
    }
  }, tabInfo[listTab].help), !loading && groupList.length > 0 && tabGroups[listTab].length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "12px 0"
    }
  }, tabInfo[listTab].empty), !loading && tabGroups[listTab].map(renderGroup), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 운용(중간관리자) 인원 관리 패널 (관리자 전용)                          */
/* ------------------------------------------------------------------ */
function ManagerAdminPanel({
  branch,
  isSuperAdmin,
  onClose
}) {
  const [viewBranch, setViewBranch] = useState(branch); // 전체관리자만 전환 가능, 그 외엔 항상 본인 소속
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => {
    setLoading(true);
    waitForFirestore().then(() => loadCachedList(MANAGER_CACHE_KEY, MANAGER_CACHE_TTL_MS, () => window.ManagerAPI.list(), true // 관리 화면이라 항상 최신 데이터로 새로 불러오고, 그 결과로 캐시도 갱신해요
    )).then(data => setList(data.filter(m => m.branch === viewBranch))).catch(err => alert("불러오기 실패: " + (err && err.message ? err.message : err))).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [viewBranch]);
  const handleAdd = () => {
    const name = newName.trim();
    if (!name) {
      alert("이름을 입력해주세요");
      return;
    }
    if (list.some(m => m.name === name && m.branch === viewBranch)) {
      alert("이미 등록된 이름이에요");
      return;
    }
    setSaving(true);
    window.ManagerAPI.add({
      name,
      branch: viewBranch
    }).then(() => {
      setNewName("");
      load();
    }).catch(err => alert("추가 실패: " + (err && err.message ? err.message : err))).finally(() => setSaving(false));
  };
  const handleRemove = m => {
    if (!confirm(`${m.name} (${m.branch})님을 운용 명단에서 삭제할까요?`)) return;
    window.ManagerAPI.remove(m.id).then(() => {
      setList(prev => prev.filter(x => x.id !== m.id));
      invalidateCachedList(MANAGER_CACHE_KEY);
    }).catch(err => alert("삭제 실패: " + (err && err.message ? err.message : err)));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, viewBranch, " 운용 인원 관리"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "12px"
    }
  }, "인사이동으로 인원이 바뀌면 여기서 바로 추가/삭제하면 돼요 (", viewBranch, " 소속만 관리해요)"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "6px",
      marginBottom: "16px"
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...styles.select,
      flex: 1,
      marginBottom: 0
    },
    placeholder: "이름 입력",
    value: newName,
    onChange: e => setNewName(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    style: adminStyles.approveBtn,
    disabled: saving,
    onClick: handleAdd
  }, "추가")), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && list.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "등록된 운용 인원이 없어요"), !loading && list.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.id,
    style: modal.card
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, m.name), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, m.branch)), /*#__PURE__*/React.createElement("button", {
    style: adminStyles.rejectBtn,
    onClick: () => handleRemove(m)
  }, "삭제"))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}

/* ------------------------------------------------------------------ */
/* 가져오기 테스트 패널 (관리자 전용, TEST_MODE에서만 노출)                */
/* 교번앱이 쓰는 검증된 VACATION_API_URL로 경산 휴가 데이터를 가져와        */
/* 확인·집계 후 실제로 저장까지 할 수 있어요                              */
/* ------------------------------------------------------------------ */

// 스프레드시트 "신청일" 값을 {year, month, day}로 변환. 두 가지 형식이 섞여 있어요:
// 1) "10.1", "12.22" 같은 직접입력(월.일, 또는 월/일) - 휴가일(vacationDateStr) 기준으로 연도를 추정해요
//    (신청월이 휴가월보다 크면 전년도로 - 예: 신청 "12.1", 휴가 "2026-01-01" → 2025년 12월 1일)
// 2) "2025-12-04T15:00:00.000Z" 같은 ISO 시각(시트 날짜셀이 자동변환된 것) - UTC라 KST로 9시간 보정해요
function parseReqDateToYMD(reqDateRaw, vacationDateStr) {
  if (!reqDateRaw) return null;
  const raw = String(reqDateRaw).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoMatch) {
    const utcDate = new Date(raw);
    if (isNaN(utcDate.getTime())) return null;
    const kst = new Date(utcDate.getTime() + 9 * 60 * 60000);
    return {
      year: kst.getUTCFullYear(),
      month: kst.getUTCMonth() + 1,
      day: kst.getUTCDate()
    };
  }
  const dotMatch = raw.match(/^(\d{1,2})[./](\d{1,2})$/);
  if (dotMatch) {
    const month = parseInt(dotMatch[1], 10);
    const day = parseInt(dotMatch[2], 10);
    if (!month || !day) return null;
    const vacYear = parseInt(vacationDateStr.slice(0, 4), 10);
    const vacMonth = parseInt(vacationDateStr.slice(5, 7), 10);
    const year = month > vacMonth ? vacYear - 1 : vacYear;
    return {
      year,
      month,
      day
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 데이터 초기화 패널 - TEST_MODE 종료 후에도 계속 남아있어요.               */
/* 문양: 휴가 기록 전체 초기화 (실사용 전환 직전, 테스트 데이터 정리용)        */
/* ------------------------------------------------------------------ */
function DataResetPanel({
  onClose,
  branch
}) {
  const [working, setWorking] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupResult, setBackupResult] = useState(null);

  // 이 소속 휴가 기록 전체 삭제 - 실사용 전환 직전에 테스트로 쌓인 기록을 비울 때
  const handleResetAllBranchData = () => {
    if (!confirm(`⚠️ ${branch} 소속의 휴가 기록을 전부 삭제할까요?\n\n` + `지금까지 신청/저장된 기록이 전부 사라져요 (되돌릴 수 없어요).`)) return;
    if (!confirm("정말로 진행할까요? 한 번 더 확인할게요.")) return;
    setWorking(true);
    Promise.resolve().then(() => VacFacade.removeAllForBranch(branch)).then(count => {
      alert(`${branch} 휴가 기록 ${count}건을 전부 삭제했어요.`);
    }).catch(err => alert("삭제 중 오류: " + (err && err.message ? err.message : err))).finally(() => setWorking(false));
  };

  // 수동 백업 - 자동 백업(1주 1회, 조건 맞을 때만)과 완전히 같은 로직을 그 자리에서 바로 실행해요.
  // ⚠️ 휴가앱(경산 실제 프로젝트)에서만 보이는 버튼이에요 - 실제 스프레드시트에 그대로 쓰여서,
  // 문양테스트버전에서 눌러버리면 테스트 데이터가 진짜 백업 기록에 섞여 들어가요.
  const handleBackupNow = () => {
    if (!confirm("지금 바로 경산 휴가 데이터를 스프레드시트로 백업할까요?")) return;
    setBackingUp(true);
    setBackupResult(null);
    promiseWithTimeout(Promise.resolve().then(() => VacFacade.getAll("경산")).then(records => {
      const payload = (records || []).map(r => ({
        date: r.date || "",
        name: r.name || "",
        branch: r.branch || "",
        employeeId: r.employeeId || "",
        vacationType: r.vacationType || "",
        dia: r.dia == null ? "" : String(r.dia),
        status: r.status || "",
        confirmedBy: r.confirmedBy || "",
        priority: r.priority == null ? "" : r.priority,
        reqDate: r.createdAt ? formatEntryDateOnly(r.createdAt) : "",
        note: r.note || "",
        recordedBy: r.recordedBy || ""
      })).sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const pa = a.priority === "" ? Infinity : a.priority;
        const pb = b.priority === "" ? Infinity : b.priority;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name, "ko");
      });
      return fetchWithTimeout(VACATION_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          action: "backup",
          records: payload
        })
      }).then(res => res.json()).then(json => {
        if (!json || !json.ok) throw new Error(json && json.error || "백업 실패");
        return window.SystemAPI.markBackupDone().then(() => payload.length);
      });
    }), 90000, "백업").then(count => {
      setBackupResult({
        count
      });
      alert(`백업 완료! 총 ${count}건을 스프레드시트로 보냈어요.`);
    }).catch(err => {
      console.error(err);
      alert("백업 실패: " + (err && err.message ? err.message : err));
    }).finally(() => setBackingUp(false));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.sheet,
      maxWidth: "340px"
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, "🗑️ 데이터 초기화"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "16px"
    }
  }, "아직 테스트 중인 것만 모아뒀어요. 필요 없어지면 요청 주시면 없애드려요."), GS_ONLY && branch === "경산" && !TEST_MODE && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #1caa5c",
      color: "#1caa5c",
      padding: "10px",
      marginBottom: "4px"
    },
    disabled: backingUp,
    onClick: handleBackupNow
  }, backingUp ? "백업 중..." : "📤 지금 바로 스프레드시트로 백업"), backupResult && /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "14px",
      color: "#1caa5c"
    }
  }, "최근 결과: ", backupResult.count, "건 백업 완료")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e02020",
      color: "#e02020",
      marginBottom: "14px",
      padding: "10px"
    },
    disabled: working,
    onClick: handleResetAllBranchData
  }, working ? "삭제 중..." : `🗑️ ${branch} 전체 초기화 (모든 휴가 기록 삭제)`), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}
function ImportTestPanel({
  onClose,
  employees,
  managers
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]); // 검증된 VACATION_API_URL에서 받아온 원본 기록들
  const [tab, setTab] = useState("raw"); // "raw" | "tally" | "convert"
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { success, fail }
  const [importedIds, setImportedIds] = useState([]); // 방금 실제로 저장한 기록 id들 (되돌리기용)

  useEffect(() => {
    setLoading(true);
    setError("");

    // 실제 배포된 API 응답 형식(재배포 후 확인됨): { entries: { "YYYY-MM-DD": [...] }, holidays: {...} }
    // 각 항목엔 row/name/type/dia/confirmer/cancelled/note/reqDate/seq가 들어있어요.
    // 이 스크립트의 doGet은 JSONP 콜백을 감싸주지 않고 순수 JSON만 반환해서, jsonpRequest 대신
    // 일반 fetch로 받아요. 실패하면 실제로 뭐가 왔는지 에러 메시지에 같이 남겨서 바로 원인을 알 수 있게 해요.
    // 캐시버스팅용 쿼리(_=시각) + no-store로, 서비스워커/브라우저/구글 쪽 캐시에 걸려서 옛날 응답이
    // 재사용되는 걸 확실히 막아요 (같은 URL을 반복 호출하면 캐시된 옛 응답이 나올 수 있어서).
    fetch(`${VACATION_API_URL}?_=${Date.now()}`, {
      cache: "no-store"
    }).then(res => {
      if (!res.ok) throw new Error(`서버 응답 오류 (${res.status})`);
      return res.text();
    }).then(text => {
      console.log("VACATION_API_URL 원본 응답:", text.slice(0, 500));
      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        throw new Error("JSON 파싱 실패 (응답이 JSON이 아니에요) - 응답 앞부분: " + text.slice(0, 150));
      }
      if (!json || !json.entries) {
        const keyInfo = json ? `실제로 받은 키: [${Object.keys(json).join(", ")}]` : "응답이 비어있어요";
        throw new Error(json && json.error || `응답 형식이 예상과 달라요 - ${keyInfo}`);
      }
      const flat = [];
      Object.keys(json.entries).forEach(dateStr => {
        (json.entries[dateStr] || []).forEach(item => {
          if (!item || !item.name) return;
          flat.push({
            date: dateStr,
            name: String(item.name).trim(),
            type: item.type ? String(item.type).trim() : "",
            // 스프레드시트 셀이 "숫자" 형식이면 dia가 숫자로 넘어와서, 문자열 메서드를 쓰는
            // 다른 코드에서 예상 못한 오류가 날 수 있어요. 여기서 무조건 문자열로 통일해요.
            dia: item.dia == null ? "" : String(item.dia).trim(),
            cancelled: !!item.cancelled,
            confirmer: item.confirmer || null,
            reqDate: item.reqDate || null,
            // "M.d" 또는 ISO 시각 - parseReqDateToYMD로 해석
            seq: item.seq == null || item.seq === "" ? null : item.seq
          });
        });
      });
      const filtered = flat.filter(v => v.date >= IMPORT_FROM_DATE) // 이 날짜 이전 데이터는 제외
      .sort((a, b) => a.date.localeCompare(b.date));
      setRows(filtered);
    }).catch(err => {
      console.error(err);
      setError("불러오기 실패: " + (err && err.message ? err.message : err));
    }).finally(() => setLoading(false));
  }, []);
  const total = rows.length;
  const cancelledCount = rows.filter(r => r.cancelled).length;
  const activeCount = total - cancelledCount;

  // 이름 -> employeeId 매칭 (직원목록 우선, 없으면 운용 명단에서 확인). 인사이동으로 명단에 없으면 null.
  const matchEmployeeId = name => {
    const emp = (employees || []).find(e => e.name === name && e.branch === "경산");
    if (emp) return emp.id;
    const mgr = (managers || []).find(m => m.name === name && m.branch === "경산");
    if (mgr) return mgr.id;
    return null;
  };

  // 지금 "기관사 직원목록"에 실제로 있는 사람인지만 확인 (운용으로 넘어간 사람은 제외) - 미래 날짜 필터링용
  const isCurrentLineEmployee = name => (employees || []).some(e => e.name === name && e.branch === "경산");

  // 종류별 집계 미리보기 - 현재 명단에 있는 사람만 집계 (인사이동으로 빠진 사람은 기록은 가져오되 집계에서 제외)
  const NIGHT_COMPANION_TYPES = ["연차비", "분지비", "장재비"];
  const tallyByPerson = {};
  rows.forEach(r => {
    if (r.cancelled) return;
    if (!isCapacityType(r.type)) return;
    if (NIGHT_COMPANION_TYPES.includes(r.type)) return;
    if (!isCurrentLineEmployee(r.name)) return; // 지금 기관사가 아니면 집계 제외
    if (!tallyByPerson[r.name]) tallyByPerson[r.name] = {};
    tallyByPerson[r.name][r.type] = (tallyByPerson[r.name][r.type] || 0) + 1;
  });
  const tallyList = Object.keys(tallyByPerson).sort((a, b) => a.localeCompare(b, "ko")).map(name => ({
    name,
    summary: Object.entries(tallyByPerson[name]).map(([t, c]) => `${t} ${c}`).join(" · ")
  }));

  // 전체 기간(과거+미래) - 실제 앱에서 쓰는 Firestore 레코드 형태로 변환
  // 과거 ~ 오늘+2일까지는 이미 확정된 거나 마찬가지라 "확인됨"으로 자동 처리하고,
  // 그보다 먼 미래 날짜만 운용이 앱에서 직접 확인하도록 "대기중"으로 남겨둬요.
  // 인사이동으로 명단에 없는 사람: 과거 기록은 그대로 가져오되(이미 지난 사실이니까),
  // 오늘 이후(미래) 기록은 혼란 방지를 위해 아예 제외해요.
  const today = todayStr();
  const cutoffDate = (() => {
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() + 2);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${dd}`;
  })();
  const excludedFutureCount = rows.filter(r => r.date >= today && !isCurrentLineEmployee(r.name)).length;
  const converted = rows.filter(r => isCurrentLineEmployee(r.name) || r.date < today) // 미래+지금 기관사 아닌 사람은 제외
  .map(r => {
    const matchedId = matchEmployeeId(r.name);
    const autoConfirmed = r.date <= cutoffDate;
    let createdAt = null;
    let createdAtDateOnly = false;
    const parsed = parseReqDateToYMD(r.reqDate, r.date);
    if (parsed && window.VacationAPI && typeof window.VacationAPI.timestampFromDate === "function") {
      try {
        const ts = window.VacationAPI.timestampFromDate(parsed.year, parsed.month, parsed.day);
        // timestampFromDate가 실수로 async(Promise 반환)로 정의돼 있으면 여기서 걸러내요
        if (ts && typeof ts.then !== "function") {
          createdAt = ts;
          createdAtDateOnly = true;
        }
      } catch (err) {
        console.error("신청일 변환 실패:", err);
      }
    }
    return {
      date: r.date,
      name: r.name,
      branch: "경산",
      employeeId: matchedId || `departed-${r.name}`,
      isDeparted: !isCurrentLineEmployee(r.name),
      vacationType: r.type,
      dia: r.dia,
      status: r.cancelled ? "취소됨" : "정상",
      confirmedBy: r.confirmer || (autoConfirmed ? "확인" : null),
      priority: isCapacityType(r.type) ? r.seq || 0 : null,
      // 일단 원본 순번(임시), 아래에서 날짜별로 다시 매김
      createdAt,
      createdAtDateOnly
    };
  });
  // 제외된 사람 때문에 순번에 구멍이 생기지 않도록, 날짜별로 보장휴가 순번을 1번부터 다시 매겨요
  const priorityCounters = {};
  converted.filter(c => c.priority != null).sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority).forEach(c => {
    priorityCounters[c.date] = (priorityCounters[c.date] || 0) + 1;
    c.priority = priorityCounters[c.date];
  });
  const departedCount = converted.filter(c => c.isDeparted).length;
  const handleRealImport = () => {
    if (converted.length === 0) {
      alert("가져올 기록이 없어요");
      return;
    }
    if (!confirm(`전체 ${converted.length}건을 실제로 저장할까요?\n` + `(과거 날짜는 이미 사용한 기록으로, 미래 날짜는 확인 대기중으로 들어가요.\n` + `달력에 바로 나타나요. 문제 있으면 "방금 저장한 것 되돌리기"로 지울 수 있어요)`)) return;
    setImporting(true);
    setImportResult(null);

    // 한 건씩 저장하면 실시간 리스너가 매번 다시 그려지면서 (특히 건수가 많을 때) 화면이
    // 버벅이거나 멈출 수 있어서, 여러 건을 묶어서 한 번에 저장하는 방식으로 처리해요.
    const payload = converted.map(c => ({
      name: c.name,
      branch: c.branch,
      employeeId: c.employeeId,
      vacationType: c.vacationType,
      dia: c.dia,
      date: c.date,
      status: c.status,
      ...(c.priority != null ? {
        priority: c.priority
      } : {}),
      ...(c.confirmedBy ? {
        confirmedBy: c.confirmedBy
      } : {}),
      ...(c.createdAt ? {
        createdAt: c.createdAt,
        createdAtDateOnly: true
      } : {})
    }));
    Promise.resolve().then(() => {
      if (USE_DAY_DOCS) {
        if (!window.VacationDayAPI || typeof window.VacationDayAPI.bulkSetDays !== "function") {
          throw new Error("index.html에 VacationDayAPI.bulkSetDays 함수가 아직 없어요. index.html을 먼저 업데이트해주세요.");
        }
      } else if (!window.VacationAPI || typeof window.VacationAPI.bulkImport !== "function") {
        throw new Error("index.html에 VacationAPI.bulkImport 함수가 아직 없어요. index.html을 먼저 업데이트해주세요.");
      }
      return VacFacade.bulkImport("경산", payload);
    }).then(ids => {
      setImportedIds(prev => [...prev, ...ids]);
      setImportResult({
        success: ids.length,
        fail: converted.length - ids.length
      });
    }).catch(err => {
      console.error(err);
      alert("저장 실패: " + (err && err.message ? err.message : err));
      setImportResult({
        success: 0,
        fail: converted.length
      });
    }).finally(() => setImporting(false));
  };
  const handleUndoImport = () => {
    if (importedIds.length === 0) return;
    if (!confirm(`방금 저장한 ${importedIds.length}건을 전부 삭제할까요? (되돌릴 수 없어요)`)) return;
    setImporting(true);
    Promise.resolve().then(() => Promise.all(importedIds.map(ref => VacFacade.remove(ref.branch, ref.date, ref.id)))).then(() => {
      setImportedIds([]);
      setImportResult(null);
      alert("삭제했어요");
    }).catch(err => alert("삭제 중 오류: " + (err && err.message ? err.message : err))).finally(() => setImporting(false));
  };

  // 경산 휴가 기록 전체 삭제 - 중복 저장 등으로 꼬였을 때, 완전히 비우고 처음부터 다시 가져오기 위한 기능
  const handleResetAllBranchData = branch => {
    if (!confirm(`⚠️ ${branch} 소속의 휴가 기록을 전부 삭제할까요?\n\n` + `지금까지 신청/저장된 기록이 전부 사라져요 (되돌릴 수 없어요). 다른 소속 데이터는 전혀 안 건드려요.\n` + (branch === "경산" ? "삭제 후 위쪽 '가져오기' 탭에서 다시 '실제로 저장하기'를 누르면 깨끗하게 다시 채울 수 있어요." : ""))) return;
    if (!confirm("정말로 진행할까요? 한 번 더 확인할게요.")) return;
    setImporting(true);
    Promise.resolve().then(() => VacFacade.removeAllForBranch(branch)).then(count => {
      alert(`${branch} 휴가 기록 ${count}건을 전부 삭제했어요.`);
      setImportedIds([]);
      setImportResult(null);
    }).catch(err => alert("삭제 중 오류: " + (err && err.message ? err.message : err))).finally(() => setImporting(false));
  };

  // 휴충당 신청 기록 전체 삭제 (경산 전용) - 테스트 데이터를 지우고 처음부터 다시 시작할 때
  const handleResetHyuchungdang = () => {
    if (!confirm("⚠️ 휴충당 신청/지정 기록을 전부 삭제할까요?\n\n" + "지금까지 신청·확정된 휴충당 기록이 전부 사라져요 (되돌릴 수 없어요). 휴가 기록은 안 건드려요.")) return;
    if (!confirm("정말로 진행할까요? 한 번 더 확인할게요.")) return;
    setImporting(true);
    Promise.resolve().then(() => {
      if (!window.HyuchungdangAPI || typeof window.HyuchungdangAPI.removeAllForBranch !== "function") {
        throw new Error("index.html에 HyuchungdangAPI.removeAllForBranch 함수가 아직 없어요. index.html을 먼저 업데이트해주세요.");
      }
      return window.HyuchungdangAPI.removeAllForBranch("경산");
    }).then(count => {
      alert(`휴충당 기록 ${count}건을 전부 삭제했어요.`);
    }).catch(err => alert("삭제 중 오류: " + (err && err.message ? err.message : err))).finally(() => setImporting(false));
  };

  // 예전 코드로 저장된 "가져오기(자동확인)" 문구만 "확인"으로 바꿔주는 일회성 정리 (기존 기록은 그대로 유지)
  const handleFixAutoConfirmLabel = () => {
    setImporting(true);
    Promise.resolve().then(() => window.VacationAPI.fixAutoConfirmLabel()).then(count => {
      alert(`"가져오기(자동확인)" 문구 ${count}건을 "확인"으로 정리했어요.`);
    }).catch(err => alert("정리 중 오류: " + (err && err.message ? err.message : err))).finally(() => setImporting(false));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: modal.overlay,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.sheet,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.dateTitle
  }, "가져오기 테스트 (검증된 API 사용)"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "14px"
    }
  }, "교번앱이 쓰는 안정적인 API예요. ", IMPORT_FROM_DATE, " 이후 기록만 가져와요. 아직 Firestore엔 저장 안 해요 - 확인용이에요."), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러오는 중..."), !loading && error && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#e02020",
      fontSize: "13px",
      padding: "10px 0",
      whiteSpace: "pre-wrap"
    }
  }, error), !loading && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "5px",
      marginBottom: "14px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: tab === "raw" ? adminStyles.tabBtnActive : adminStyles.tabBtn,
    onClick: () => setTab("raw")
  }, "전체 (", total, ")"), /*#__PURE__*/React.createElement("button", {
    style: tab === "tally" ? adminStyles.tabBtnActive : adminStyles.tabBtn,
    onClick: () => setTab("tally")
  }, "종류별 집계"), /*#__PURE__*/React.createElement("button", {
    style: tab === "convert" ? adminStyles.tabBtnActive : adminStyles.tabBtn,
    onClick: () => setTab("convert")
  }, "가져오기")), tab === "raw" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "10px",
      padding: "10px 14px",
      marginBottom: "16px",
      fontSize: "13px",
      fontWeight: 700,
      color: "#1b3a5c"
    }
  }, "전체 ", total, "건 · 정상 ", activeCount, " · 취소 ", cancelledCount), rows.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "불러온 데이터가 없어요"), rows.map((r, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    style: {
      ...modal.card,
      flexDirection: "column",
      alignItems: "stretch"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, r.date, " · ", r.name), /*#__PURE__*/React.createElement("div", {
    style: modal.dia
  }, r.dia)), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, r.type || "(종류 없음)", r.cancelled ? " · 취소됨" : "", r.reqDate ? ` · 신청일 ${r.reqDate}` : "", r.seq != null ? ` · 순번 ${r.seq}` : "")))), tab === "tally" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "10px"
    }
  }, "현재 직원목록/운용명단에 있는 사람만 집계 (인사이동으로 빠진 사람 제외) · 취소·연차비류 제외"), tallyList.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "집계할 기록이 없어요"), tallyList.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.name,
    style: modal.card
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, t.name), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, t.summary))))), tab === "convert" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modal.countText,
      marginBottom: "10px"
    }
  }, "전체 기간을 Firestore 형태로 변환한 미리보기예요 (오늘: ", today, ", ", cutoffDate, "까지는 자동 확인 처리)", departedCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#e08a20",
      fontWeight: 700
    }
  }, " ", "(⚠️ 과거 기록 중 인사이동 등으로 명단에 없는 사람 ", departedCount, "건 - 기록은 그대로 가져오되 집계엔 안 잡혀요)"), excludedFutureCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#e02020",
      fontWeight: 700
    }
  }, " ", "(🚫 오늘 이후 날짜 중 명단에 없는 사람 ", excludedFutureCount, "건은 혼란 방지를 위해 아예 제외했어요)")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...adminStyles.approveBtn,
      width: "100%",
      padding: "12px",
      marginBottom: "8px"
    },
    disabled: importing || converted.length === 0,
    onClick: handleRealImport
  }, importing ? "저장 중..." : `실제로 저장하기 (${converted.length}건)`), importResult && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f9fb",
      borderRadius: "10px",
      padding: "10px 14px",
      marginBottom: "8px",
      fontSize: "13px",
      fontWeight: 700,
      color: "#1b3a5c"
    }
  }, "저장 완료: 성공 ", importResult.success, "건 · 실패 ", importResult.fail, "건 — 달력에서 확인해보세요!"), importedIds.length > 0 && /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e02020",
      color: "#e02020",
      marginBottom: "8px",
      padding: "10px"
    },
    disabled: importing,
    onClick: handleUndoImport
  }, "🔄 방금 저장한 ", importedIds.length, "건 되돌리기(삭제)"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #1b3a5c",
      color: "#1b3a5c",
      marginBottom: "8px",
      padding: "10px"
    },
    disabled: importing,
    onClick: handleFixAutoConfirmLabel
  }, "✏️ \"가져오기(자동확인)\" → \"확인\"으로 문구만 정리"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e02020",
      color: "#e02020",
      marginBottom: "8px",
      padding: "10px"
    },
    disabled: importing,
    onClick: () => handleResetAllBranchData("경산")
  }, "🗑️ 경산 전체 초기화 (모든 휴가 기록 삭제)"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...styles.button,
      border: "1px dashed #e08a20",
      color: "#e08a20",
      marginBottom: "14px",
      padding: "10px"
    },
    disabled: importing,
    onClick: handleResetHyuchungdang
  }, "🔁 휴충당 전체 초기화 (경산 - 신청/지정 기록 삭제)"), converted.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      padding: "20px 0"
    }
  }, "가져올 기록이 없어요"), converted.map((c, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    style: {
      ...modal.card,
      flexDirection: "column",
      alignItems: "stretch"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: modal.name
  }, c.date, " · ", c.name), /*#__PURE__*/React.createElement("div", {
    style: modal.dia
  }, c.dia)), /*#__PURE__*/React.createElement("div", {
    style: modal.typeRow
  }, c.vacationType, " · ", c.status, c.confirmedBy ? " · ✅확인됨" : " · 확인 대기중"), c.createdAt ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "#1b3a5c",
      marginTop: "2px"
    }
  }, "📅 신청일 인식됨: ", formatEntryTime(c.createdAt, true)) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "#e02020",
      marginTop: "2px"
    }
  }, "⚠️ 신청일 인식 실패 - 가져온 시각으로 기록돼요"), c.isDeparted && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "#e08a20",
      marginTop: "2px"
    }
  }, "⚠️ 현재 명단에 없는 사람 (집계 제외)"))))), /*#__PURE__*/React.createElement("button", {
    style: modal.closeBtn,
    onClick: onClose
  }, "닫기")));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ErrorBoundary, {
  onClose: () => window.location.reload(),
  closeLabel: "새로고침"
}, /*#__PURE__*/React.createElement(App, null)));
