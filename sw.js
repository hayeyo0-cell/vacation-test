// sw.js - 최소한의 서비스워커 (PWA 설치 조건 충족 + 기본 오프라인 지원)
// v2: 캐시 우선 → 네트워크 우선으로 변경 (온라인일 땐 항상 최신 버전, 오프라인일 때만 캐시 사용)
const CACHE_NAME = "vacation-app-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 앱 껍데기(html/js/manifest/아이콘)만 대상, Firestore 등 API 호출은 항상 네트워크로 (기존과 동일)
// ⚠️ 예전엔 "캐시 우선"이라 한 번 저장되면 새 버전이 영원히 안 보이는 문제가 있었어요.
// 이제 "네트워크 우선"으로 바꿔서, 온라인이면 항상 최신 파일을 받아오고,
// 오프라인일 때만 예외적으로 캐시된 걸 보여줘요. (받아올 때마다 캐시도 최신으로 갱신)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 외부 요청(Firebase 등)은 그대로 통과

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
