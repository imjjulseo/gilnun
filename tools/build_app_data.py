"""파일럿 계산 결과 -> 앱 데이터(public/data).
데이터를 갈아끼울 때: 이 스크립트를 다시 돌리고 VERSION을 올린다.
길은 약 20m 조각으로 잘라 조각마다 값을 준다 (자연스러운 색 변화용).
환경변수 VIEWAPP: 계산 결과 폴더, APPDATA: 출력 폴더(기본은 저장소의 public/data)."""
import os, json, numpy as np, pandas as pd, geopandas as gpd, shapely
from shapely.ops import substring
from scipy.spatial import cKDTree
VERSION = '2026-11-17.pilot4'
U = os.environ.get('VIEWAPP', '/mnt/user-data/uploads/viewapp')
OUT = os.environ.get('APPDATA', os.path.join(os.path.dirname(__file__), '..', 'public', 'data'))
PIECE = 2                                     # 샘플점(10m 간격) 몇 개를 한 조각으로 묶을지
D = pd.read_parquet(f'{U}/work/pilot/scored.parquet'); L = gpd.read_parquet(f'{U}/work/walknet_links.parquet')
# 하늘 칩 값: 하늘(+45도까지, 절대 기준)이 중심이고 원경과 트인 방위가 보탠다
D['open'] = 0.60 * D.s_sky + 0.25 * D.s_depth + 0.15 * D.s_pano
L = L[L.link.isin(D.link.unique())].drop_duplicates('link').set_index('link')
to_ll = __import__('pyproj').Transformer.from_crs(5186, 4326, always_xy=True)
to_xy = __import__('pyproj').Transformer.from_crs(4326, 5186, always_xy=True)
q = lambda v: int(round(float(np.clip(v, 0, 1)) * 100))
feats = []; fid = 0
for link, g in D.groupby('link'):
    if link not in L.index: continue
    line = L.geometry[link]; ln = line.length
    if ln < 1: continue
    g = g.assign(pos=shapely.line_locate_point(line, shapely.points(g.x.values, g.y.values))).sort_values('pos')
    n = len(g); k = max(1, int(np.ceil(n / PIECE)))
    for i in range(k):
        s = g.iloc[i * PIECE:(i + 1) * PIECE]
        a = 0.0 if i == 0 else (g.pos.iloc[i * PIECE - 1] + s.pos.iloc[0]) / 2
        b = ln if i == k - 1 else (s.pos.iloc[-1] + g.pos.iloc[(i + 1) * PIECE]) / 2
        seg = substring(line, a, b)
        if seg.geom_type != 'LineString' or seg.length < 0.5: continue
        xs, ys = to_ll.transform(*np.asarray(seg.coords).T)
        fid += 1
        feats.append(dict(type='Feature', id=fid, geometry=dict(type='LineString', coordinates=[[round(x, 6), round(y, 6)] for x, y in zip(xs, ys)]),
            properties=dict(k=q(s.open.mean()), w=q(s.s_water.mean()), g=q(s.s_nature.mean()), c=int(round(min(s.f_calm.mean(), 1.15) * 100)),
                            ps=int(round(s.c_sky45.mean() * 100)), pw=round(float(s.c_water.mean()) * 100, 1), pg=int(round(s.c_nat.mean() * 100)),
                            pa=int(round(s.pano300.mean())), z=int(round(s.gz.mean())), r=1 if (s.zone == 'river').any() else 0)))
os.makedirs(f'{OUT}/pilot', exist_ok=True)
json.dump(dict(type='FeatureCollection', features=feats), open(f'{OUT}/pilot/links.json', 'w'), separators=(',', ':'))

# ---- 스팟: 이름과 설명용 값
S = pd.read_csv(f'{U}/out/pilot_spots.csv')
OA = gpd.read_parquet(f'{U}/work/osm_areas.parquet').to_crs(5186); OL = gpd.read_parquet(f'{U}/work/osm_lines.parquet').to_crs(5186)
sx, sy = to_xy.transform(S.lon.values, S.lat.values); box = shapely.box(sx.min() - 500, sy.min() - 500, sx.max() + 500, sy.max() + 500)
import re
clean = lambda t: re.sub(r'\s*\(.*?\)', '', str(t)).strip()             # 괄호 속 별칭은 뺀다
OA = OA[OA.intersects(box) & OA.name.notna() & (OA.kind == 'green')]; OL = OL[OL.intersects(box) & OL.name.notna()]
OL = OL[~OL.name.str.contains('지하차도|터널|고가|IC|JC', regex=True) & (OL.tunnel.isna() | (OL.tunnel == 'no'))]
df = np.vstack([np.load(f'{U}/work/pilot/df_e1_6_p{i}of2.npy') for i in range(2)])
hz = np.vstack([np.load(f'{U}/work/pilot/hz_e1_6_p{i}of2.npy') for i in range(2)]).astype(np.float32)
tree = cKDTree(D[['x', 'y']].values)
DIR = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
def open_dir(row):                                     # 300m 이상 트인 연속 방위 중 가장 긴 구간의 가운데 방향
    m = np.concatenate([row >= 300, row >= 300]); best = (0, 0); cur = 0
    for a in range(720):
        cur = cur + 1 if m[a] else 0
        if cur > best[0]: best = (min(cur, 360), a)
    if best[0] < 20: return None
    c = (best[1] - best[0] / 2 + 0.5) % 360; return DIR[int(((c + 22.5) % 360) // 45)]
def name_for(x, y, used):
    p = shapely.Point(x, y); cand = []
    for r in OA.itertuples():
        d = r.geometry.distance(p)
        if d < 120: cand.append((d, clean(r.name), 'park'))
    for r in OL.itertuples():
        d = r.geometry.distance(p)
        if d < 80 and r.highway not in ('motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link'): cand.append((d + 30, clean(r.name), 'steps' if r.highway == 'steps' else 'road'))
    for _, nm, kind in sorted(cand):
        if nm.replace(' ', '') not in used: return nm, kind
    return None, None
spots = []; used = set()
for r in S.itertuples():
    x, y = to_xy.transform(r.lon, r.lat); _, j = tree.query([x, y])
    nm, nk = name_for(x, y, used)
    hill = r.ground_m >= 45
    dr = open_dir(df[j])
    if nm is None: title = f"{r.dong} {dr + '쪽으로 ' if dr else ''}{'트인 언덕' if hill else '트인 길'}"
    elif nk == 'park': title = f'{nm} 옆'
    else: title = f'{nm} 언덕' if hill else nm
    if title.replace(' ', '') in used: title = f'{title} {r.rank}'
    used.update(t.replace(' ', '') for t in (nm or '', title))
    west = float(np.degrees(hz[j, 240:300].mean()))
    kind = 'w' if r.water >= 0.01 else ('g' if 'nature' in r.why else 'k')
    spots.append(dict(id=f'p{r.rank}', rank=int(r.rank), lat=r.lat, lon=r.lon, dong=r.dong, title=title, kind=kind,
                      sky=int(round(r.sky * 100)), water=round(r.water * 100, 1), nat=int(round(D.c_nat.iloc[j] * 100)), pano=int(r.pano300), dir=dr,
                      west=round(west, 1), elev=int(round(r.ground_m)), top=round(100 - r.pct_inland, 1), prom=int(round(r.prominence)), calm=bool(r.calm)))
json.dump(spots, open(f'{OUT}/pilot/spots.json', 'w'), ensure_ascii=False, separators=(',', ':'))
b = gpd.GeoSeries(L.geometry, crs=5186).to_crs(4326).total_bounds
json.dump(dict(version=VERSION, note='임시 가중치. 하늘은 +45도까지 절대 기준. 지형은 1:5000과 1:1000 등고선, 수목은 일부만 반영', regions=[dict(id='pilot', name='노량진, 본동', bbox=[round(float(v), 5) for v in b], center=[126.9445, 37.5125], zoom=14.6,
          links='pilot/links.json', spots='pilot/spots.json')]), open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
print(len(feats), 'pieces', os.path.getsize(f'{OUT}/pilot/links.json') // 1024, 'KB')
v = pd.DataFrame([f['properties'] for f in feats]); print(v[['k', 'w', 'g', 'ps']].describe(percentiles=[.25, .5, .75, .9, .97]).round(0).to_string())
for s_ in spots: print(s_['rank'], s_['title'], s_['kind'], s_['dir'], s_['west'], s_['sky'])
