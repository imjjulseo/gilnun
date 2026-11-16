"""지표 -> 점수 v2. 강변/교량과 도심(내륙)을 분리해, 도심은 도심 분포 안에서 정규화하고 '주변 대비 돌출' 스팟을 뽑는다.
출력: work/pilot/scored.parquet, out/pilot_map.html, out/pilot_map.png, out/pilot_spots.csv"""
import os, sys, glob, json, numpy as np, pandas as pd
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
H = os.environ['HOME'] + '/mnt/viewapp'; P = H + '/work/pilot'; O = H + '/out'; os.makedirs(O, exist_ok=True)
tag = (sys.argv[1] if len(sys.argv) > 1 else '1.6').replace('.', '_')
fs = sorted(glob.glob(P + f'/points_e{tag}_p*of*.parquet')); n = int(fs[0].split('of')[-1].split('.')[0]); fs = [f for f in fs if f.endswith(f'of{n}.parquet')]
D = pd.concat([pd.read_parquet(f) for f in fs], ignore_index=True)
hz = np.vstack([np.load(f.replace('points_', 'hz_').replace('.parquet', '.npy')) for f in fs]).astype(np.float32)
df = np.vstack([np.load(f.replace('points_', 'df_').replace('.parquet', '.npy')) for f in fs])
G = np.load(P + '/grids.npz'); ox0, oy1, RES, nx, ny = G['meta'][:5]; cx0, cy0, cx1, cy1 = G['meta'][9:13]; nx, ny = int(nx), int(ny)
# 강변 판정: 큰 수면(>5ha)에서 120m 이내 또는 수면 위 교량
lab, k = ndi.label(G['cls'] == 1); big = np.isin(lab, 1 + np.nonzero(ndi.sum(np.ones_like(lab), lab, np.arange(1, k + 1)) * RES * RES > 5e4)[0])
dist = ndi.distance_transform_edt(~big) * RES
c = ((D.x.values - ox0) / RES).astype(int); r = ((oy1 - D.y.values) / RES).astype(int)
D['d_river'] = dist[r, c]; D['zone'] = np.where((D.d_river < 120) | (D.deck & D.onwater), 'river', 'inland')
# 추가 지표
def longest(mask):
    d2 = np.concatenate([mask, mask], 1); best = np.zeros(len(mask), int); cur = np.zeros(len(mask), int)
    for a in range(d2.shape[1]): cur = np.where(d2[:, a], cur + 1, 0); best = np.maximum(best, cur)
    return np.minimum(best, mask.shape[1])
D['pano300'] = longest(df >= 300); D['f300'] = (df >= 300).mean(1); D['logd'] = np.log10(np.maximum(df, 2)).mean(1)
D['hz_low'] = (np.degrees(hz) < 6).mean(1)                      # 지평선이 6도 미만으로 낮은 방위 비율
D['c_nat'] = D.c_forest + D.c_green
# 랜드마크: 보이는 비율 x 겉보기 각높이(도). 4도 이상이면 만점
from pyproj import Transformer
T = Transformer.from_crs(4326, 5186, always_xy=True)
LM = dict(n_tower=(126.99107, 37.55109, 243.0, 479.7), b63=(126.94022, 37.51982, 12.0, 262.0), lotte=(127.10268, 37.51255, 15.0, 570.0))
ang = []
for k_, (lo, la, zb, zt) in LM.items():
    x, y = T.transform(lo, la); dd = np.hypot(D.x - x, D.y - y).clip(lower=50); ang.append(np.degrees(np.arctan((zt - zb) / dd)) * D['lm_' + k_])
D['lm_deg'] = np.max(ang, 0); D['lm'] = np.clip(D.lm_deg / 4.0, 0, 1)
# 차분함: 큰 도로와의 거리, 보행 전용길·공원 여부
import geopandas as gpd, shapely
OL = gpd.read_parquet(H + '/work/osm_lines.parquet').to_crs(5186); bb = OL.geometry.bounds
OL = OL[(bb.maxx > cx0 - 300) & (bb.minx < cx1 + 300) & (bb.maxy > cy0 - 300) & (bb.miny < cy1 + 300)]
def dist_to(sel, vert=False):
    g = OL[sel].geometry.values
    if len(g) == 0: return np.full(len(D), 9999.0)
    co = shapely.get_coordinates(shapely.segmentize(g, 5.0)); d_, j = cKDTree(co).query(D[['x', 'y']].values)
    if vert:                                    # 도로보다 6m 이상 높은 곳(언덕·축대 위)은 도로 영향이 적다고 보고 거리를 늘려 잡음
        zr = G['ground'][np.clip(((oy1 - co[j, 1]) / RES).astype(int), 0, ny - 1), np.clip(((co[j, 0] - ox0) / RES).astype(int), 0, nx - 1)]
        d_ = np.where(D.gz.values - zr > 6, d_ + 8 * (D.gz.values - zr), d_)
    return d_
hw = OL.highway; tun = OL.tunnel.notna() & (OL.tunnel != 'no')
D['d_major'] = dist_to(hw.isin(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']) & ~tun, vert=True)
D['d_mid'] = dist_to(hw.isin(['tertiary', 'tertiary_link']) & ~tun)
D['d_calm'] = dist_to(hw.isin(['footway', 'path', 'steps', 'pedestrian', 'track']) & OL.footway.isna() if 'footway' in OL.columns else hw.isin(['footway', 'path', 'steps', 'pedestrian', 'track']))
gcls = G['cls'][((oy1 - D.y.values) / RES).astype(int), ((D.x.values - ox0) / RES).astype(int)]
D['calm_place'] = D.park | np.isin(gcls, (2, 3)) | ((D.d_calm < 6) & (D.d_major > 25))
f_traffic = 0.40 + 0.60 * np.clip((D.d_major - 12) / (70 - 12), 0, 1)          # 큰 도로 12m 이내 0.40배 -> 70m 밖 1.0배
f_traffic = f_traffic * np.where(D.d_mid < 10, 0.85, 1.0)
D['f_calm'] = np.clip(f_traffic * np.where(D.calm_place, 1.15, 1.0) * np.where(D.crosswalk, 0.6, 1.0), 0, 1.15)
inl = D.zone == 'inland'
def nrm(v, lo=10, hi=99.5, ref=inl):
    a, b = np.percentile(v[ref], [lo, hi]); return np.clip((v - a) / max(b - a, 1e-9), 0, 1)
# 하늘 v3: 눈높이 -15도부터 +45도까지, 고도각 cos 가중(입체각 비율). 걸으며 시선을 드는 범위까지 센다.
_lo, _hi = np.radians(-15), np.radians(45)
D['c_sky45'] = ((np.sin(_hi) - np.sin(np.clip(hz, _lo, _hi))) / (np.sin(_hi) - np.sin(_lo))).mean(1)
SKY0, SKY1, NAT1 = 0.12, 0.50, 0.35           # 절대 기준: 하늘 입체각 12% 이하 0점, 50% 이상 만점. 녹지는 시야 35%면 만점
S = dict(sky=np.clip((D.c_sky45 - SKY0) / (SKY1 - SKY0), 0, 1), depth=nrm(D.logd), pano=nrm(D.pano300), water=np.clip(D.c_water / 0.03, 0, 1), nature=np.clip(D.c_nat / NAT1, 0, 1), landmark=D.lm.values)
W = dict(sky=0.25, depth=0.20, pano=0.15, water=0.20, nature=0.15, landmark=0.05)
for k_, v in S.items(): D['s_' + k_] = np.asarray(v)
D['score_view'] = 100 * sum(W[k_] * D['s_' + k_] for k_ in W)      # 순수 조망 (하늘 트인 길 포함)
D['score'] = np.clip(D.score_view * D.f_calm, 0, 100)                 # 기본: 산책·데이트 (큰 도로변 감점, 공원·보행길 가점)
D['open'] = 100 * (0.5 * D.s_sky + 0.3 * D.s_depth + 0.2 * D.s_pano)             # 하늘·개방감 단독 점수
D['pct_inland'] = np.where(inl, D.score[inl].rank(pct=True).reindex(D.index) * 100, np.nan)
D['pct_view'] = np.where(inl, D.score_view[inl].rank(pct=True).reindex(D.index) * 100, np.nan)
# 주변 대비 돌출: 반경 250m 내 도심 점들의 중앙값과의 차
tr = cKDTree(D[['x', 'y']].values); nb = tr.query_ball_point(D[['x', 'y']].values, 250.0); sc = D.score.values
D['local_med'] = [np.median(sc[i]) for i in nb]; D['prom'] = D.score - D.local_med
D.to_parquet(P + '/scored.parquet')
print('n', len(D), D.zone.value_counts().to_dict())
print('inland score p10 %.0f p50 %.0f p90 %.0f p99 %.0f | river p50 %.0f' % (*np.percentile(D.score[inl], [10, 50, 90, 99]), D.score[~inl].median()))
cols = ['score', 'score_view', 'pct_inland', 'prom', 'c_sky', 'c_water', 'd_major', 'lm_deg']
for nm, lo, la in (('효사정', 126.96291, 37.51054), ('사육신공원', 126.94888, 37.51382), ('용양봉저정', 126.9558, 37.51288), ('노량진역 앞', 126.9425, 37.5135), ('노량진 학원가 골목', 126.9440, 37.5120)):
    x, y = T.transform(lo, la); d = np.hypot(D.x - x, D.y - y); s = D[d < 70]
    if len(s): b = s.sort_values('score').iloc[-1]; print(nm, 'n%d %s best:' % (len(s), b.zone), ' '.join('%s=%.2f' % (c_, b[c_]) for c_ in cols))
    else: print(nm, 'no points within 70m; nearest %.0fm' % d.min())
def nms(S_, key, k_, rad=150):
    top = []
    for r_ in S_.sort_values(key, ascending=False).itertuples():
        if all((r_.x - t.x) ** 2 + (r_.y - t.y) ** 2 > rad ** 2 for t in top): top.append(r_)
        if len(top) == k_: break
    return top
I = D[inl & ~D.deck & ~D.crosswalk & (D.d_major > 25)]
spots = nms(I[I.pct_inland >= 90], 'prom', 20)            # 도심 상위 10% 중 주변 대비 가장 돌출된 곳
def why(t):
    p = sorted(((W[k_] * getattr(t, 's_' + k_), k_) for k_ in W), reverse=True)[:2]; return '+'.join(k_ for _, k_ in p)
rows = [dict(rank=i + 1, lat=round(t.lat, 6), lon=round(t.lon, 6), dong=t.dong, score=round(t.score, 1), pct_inland=round(t.pct_inland, 1), prominence=round(t.prom, 1), sky=round(t.c_sky45, 2), water=round(t.c_water, 3),
             pano300=int(t.pano300), calm=bool(t.calm_place), d_major=int(min(t.d_major, 999)), ground_m=round(t.gz, 1), d_river=int(t.d_river), why=why(t)) for i, t in enumerate(spots)]
pd.DataFrame(rows).to_csv(O + '/pilot_spots.csv', index=False, encoding='utf-8-sig'); print(pd.DataFrame(rows).to_string(index=False))
# ---- 지도
D['disp'] = np.where(inl, D.pct_inland, 100.0)
D['disp2'] = np.where(inl, D.pct_view, 100.0)
pts = D[['lat', 'lon', 'disp', 'score', 'c_sky', 'c_water', 'pano300', 'd_major', 'prom', 'disp2']].round({'lat': 6, 'lon': 6, 'disp': 0, 'score': 1, 'c_sky': 2, 'c_water': 3, 'pano300': 0, 'd_major': 0, 'prom': 1, 'disp2': 0}).values.tolist()
zone = (D.zone == 'river').astype(int).tolist()
html = '''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>뷰 점수 파일럿 (노량진·대방)</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#m{height:100%;margin:0}.lg{position:absolute;z-index:999;left:10px;bottom:24px;background:#fff;padding:8px 10px;border-radius:8px;font:12px system-ui;box-shadow:0 1px 4px #0004;max-width:220px}.bar{width:200px;height:10px;background:linear-gradient(90deg,#2b3a67,#3f7cac,#7fc8a9,#f6e27f,#f28c38,#d7263d)}</style></head>
<body><div id="m"></div><div class="lg"><b>도심 뷰 점수 (도심 내 백분위)</b><div><label><input type=radio name=md value=2 checked> 산책·데이트</label> <label><input type=radio name=md value=9> 하늘 트인 길</label></div><div class="bar"></div><div style="display:flex;justify-content:space-between"><span>하위</span><span>상위</span></div><div>회색: 강변·교량 (별도 취급)<br>핀: 주변 대비 돌출 스팟 20곳</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const P=__PTS__,Z=__ZONE__,TOP=__TOP__;const m=L.map('m',{preferCanvas:true}).setView([37.511,126.943],15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(m);
const st=[[0,'#2b3a67'],[40,'#3f7cac'],[60,'#7fc8a9'],[75,'#f6e27f'],[88,'#f28c38'],[96,'#d7263d']];
function col(s){let c=st[0][1];for(const [v,k] of st)if(s>=v)c=k;return c}
const r=L.canvas({padding:.5});const MK=[];
P.forEach((p,i)=>{MK.push(L.circleMarker([p[0],p[1]],{renderer:r,radius:3.2,stroke:false,fillColor:Z[i]?'#8a8f98':col(p[2]),fillOpacity:Z[i]?.55:.9}).bindPopup(`${Z[i]?'강변·교량':'도심 상위 '+(100-p[2])+'%'} · 점수 ${p[3]}<br>하늘 ${p[4]} · 물 ${p[5]}<br>트인 방위 ${p[6]}° · 큰 도로까지 ${p[7]}m<br>주변 대비 ${p[8]>0?'+':''}${p[8]}`).addTo(m))});
document.querySelectorAll('input[name=md]').forEach(e=>e.onchange=()=>{const k=+e.value;MK.forEach((c,i)=>{if(!Z[i])c.setStyle({fillColor:col(P[i][k])})})});
for(const t of TOP){L.marker([t.lat,t.lon],{title:'#'+t.rank}).bindPopup(`<b>#${t.rank}</b> ${t.dong}<br>점수 ${t.score} (도심 상위 ${(100-t.pct_inland).toFixed(1)}%)<br>주변 대비 +${t.prominence}<br>${t.why}`).addTo(m)}
</script></body></html>'''.replace('__PTS__', json.dumps(pts)).replace('__ZONE__', json.dumps(zone)).replace('__TOP__', json.dumps(rows, ensure_ascii=False))
open(O + '/pilot_map.html', 'w').write(html)
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(15, 9.5), dpi=110); st = 2; ext = (ox0, ox0 + nx * RES, oy1 - ny * RES, oy1)
ax.imshow(np.where(G['cls'][::st, ::st] == 1, 1.0, np.nan), extent=ext, cmap='Blues', vmin=0, vmax=1.6)
ax.imshow(np.where(G['bh'][::st, ::st] > 0, 1.0, np.nan), extent=ext, cmap='Greys', vmin=0, vmax=3, alpha=.55)
R_ = D[~inl]; ax.scatter(R_.x, R_.y, c='#9aa0a8', s=2, linewidths=0)
I2 = D[inl].sort_values('pct_inland'); sc_ = ax.scatter(I2.x, I2.y, c=I2.pct_inland, s=3.5, cmap='turbo', vmin=0, vmax=100, linewidths=0)
for i, t in enumerate(spots): ax.annotate(str(i + 1), (t.x, t.y), color='k', fontsize=9, fontweight='bold', bbox=dict(boxstyle='circle,pad=0.15', fc='w', ec='k', lw=.6))
ax.set_xlim(cx0 - 100, cx1 + 100); ax.set_ylim(cy0 - 100, cy1 + 100); ax.set_aspect('equal'); ax.axis('off'); plt.colorbar(sc_, shrink=.6, label='inland percentile')
plt.tight_layout(); plt.savefig(O + '/pilot_map.png'); print('saved')
