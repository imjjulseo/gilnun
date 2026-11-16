"""파일럿 계산 결과 -> 앱 데이터(public/data).
데이터를 갈아끼울 때: 이 스크립트를 다시 돌리고 manifest.json의 version을 올린다.
길은 약 20m 조각으로 잘라 조각마다 값을 준다 (자연스러운 색 변화용)."""
import os, json, numpy as np, pandas as pd, geopandas as gpd, shapely
from shapely.ops import substring
U = os.environ.get('VIEWAPP', '/mnt/user-data/uploads/viewapp'); OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
PIECE = 2                                     # 샘플점(10m 간격) 몇 개를 한 조각으로 묶을지
D = pd.read_parquet(f'{U}/work/pilot/scored.parquet'); L = gpd.read_parquet(f'{U}/work/walknet_links.parquet')
D['open'] = (0.25 * D.s_sky + 0.20 * D.s_depth + 0.15 * D.s_pano) / 0.60
L = L[L.link.isin(D.link.unique())].drop_duplicates('link').set_index('link')
to_ll = __import__('pyproj').Transformer.from_crs(5186, 4326, always_xy=True)
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
                            ps=int(round(s.c_sky.mean() * 100)), pw=round(float(s.c_water.mean()) * 100, 1), pg=int(round(s.c_nat.mean() * 100)),
                            pa=int(round(s.pano300.mean())), z=int(round(s.gz.mean())), r=1 if (s.zone == 'river').any() else 0)))
os.makedirs(f'{OUT}/pilot', exist_ok=True)
json.dump(dict(type='FeatureCollection', features=feats), open(f'{OUT}/pilot/links.json', 'w'), separators=(',', ':'))
S = pd.read_csv(f'{U}/out/pilot_spots.csv'); spots = []
for r in S.itertuples():
    kind = 'w' if r.water >= 0.01 else ('g' if 'nature' in r.why else 'k')
    spots.append(dict(id=f'p{r.rank}', rank=int(r.rank), lat=r.lat, lon=r.lon, dong=r.dong, title=f"{r.dong} {'언덕길' if r.ground_m >= 45 else '트인 길'}", kind=kind,
                      sky=int(round(r.sky * 100)), water=round(r.water * 100, 1), pano=int(r.pano300), elev=int(round(r.ground_m)), top=round(100 - r.pct_inland, 1), prom=int(round(r.prominence)), calm=bool(r.calm)))
json.dump(spots, open(f'{OUT}/pilot/spots.json', 'w'), ensure_ascii=False, separators=(',', ':'))
b = gpd.GeoSeries(L.geometry, crs=5186).to_crs(4326).total_bounds
json.dump(dict(version='2026-11-17.pilot3', note='임시 가중치. 지형은 1:5000과 1:1000 등고선, 수목은 일부만 반영', regions=[dict(id='pilot', name='노량진, 본동', bbox=[round(float(v), 5) for v in b], center=[126.9445, 37.5125], zoom=14.6,
          links='pilot/links.json', spots='pilot/spots.json')]), open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
print(len(feats), 'pieces', os.path.getsize(f'{OUT}/pilot/links.json') // 1024, 'KB')
v = pd.DataFrame([f['properties'] for f in feats]); print(v[['k', 'w', 'g']].describe(percentiles=[.5, .75, .9, .97]).round(0).to_string())
