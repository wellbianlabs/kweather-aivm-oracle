"use strict";

/**
 * Region registry. `code` is BOTH the on-chain index used for O(1) lookup (PRD §5.2)
 * AND the path parameter the K-Weather gateway expects — a 10-digit 법정동코드.
 * The client falls back to the 시군구 code (first 5 digits + "00000") automatically.
 */
const REGIONS = [
  { code: 1168000000, name: "서울 강남구", lat: 37.5172, lon: 127.0473 },
  { code: 2611000000, name: "부산 중구", lat: 35.1064, lon: 129.0323 },
  { code: 4617000000, name: "전남 나주시", lat: 35.0158, lon: 126.7108 }, // 배 주산지
  { code: 4380000000, name: "충북 영동군", lat: 36.175, lon: 127.7765 }, // 포도 주산지
  { code: 5011000000, name: "제주 제주시", lat: 33.4996, lon: 126.5312 },
];

const BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));

function getRegion(code) {
  return BY_CODE.get(Number(code));
}

module.exports = { REGIONS, getRegion };
