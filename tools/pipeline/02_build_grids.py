"""파일럿 격자 v2: 근거리 2m (지면 DTM/건물높이/수목높이/피복) + 원거리 30m 표면. 출력: work/pilot/grids.npz
지면: 1:1000 등고선·표고점(범위 내) + 1:5000 연속수치지도 등고선·표고점(범위 밖) -> TIN 선형보간.
건물: 건물대장 높이 > 층수*3.25(건물대장) > 층수*3.25(1:1000) > OSM 고층 보정.  수목: 1:1000 가로수·정원수 점 + OSM 숲."""
import os, sys, glob, numpy as np, pandas as pd, geopandas as gpd, rasterio, shapely, pyogrio
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
from rasterio.features import rasterize
from scipy import ndimage as ndi
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import cKDTree
from pyproj import Transformer
H = os.environ['HOME'] + '/mnt/viewapp'; out = H + '/work/pilot'; os.makedirs(out, exist_ok=True)
T5 = sys.argv[1] if len(sys.argv) > 1 else os.environ['HOME'] + '/scratch/t5'       # 압축 푼 1:5000 SHP 폴더
T = Transformer.from_crs(4326, 5186, always_xy=True)
CALC = (126.920, 37.500, 126.966, 37.525); OCC = (126.890, 37.480, 126.995, 37.550)
RES, FRES, FAR, FLH = 2.0, 30.0, 35000.0, 3.25
TREE_H, TREE_R, FOREST_H = 10.0, 3.0, 12.0          # 가로수 기본 수고/수관반경(중구 실측 중앙값), 숲 높이
def box(b):
    x0, y0 = T.transform(b[0], b[1]); x1, y1 = T.transform(b[2], b[3]); return x0, y0, x1, y1
cx0, cy0, cx1, cy1 = box(CALC); ox0, oy0, ox1, oy1 = [round(v / RES) * RES for v in box(OCC)]
nx, ny = int((ox1 - ox0) / RES), int((oy1 - oy0) / RES); ntr = from_origin(ox0, oy1, RES, RES)
OB = shapely.box(ox0, oy0, ox1, oy1); OBM = OB.buffer(600)
mx, my = (cx0 + cx1) / 2, (cy0 + cy1) / 2
fx0, fy1 = round((mx - FAR) / FRES) * FRES, round((my + FAR) / FRES) * FRES; fn = int(2 * FAR / FRES); ftr = from_origin(fx0, fy1, FRES, FRES)
# ---- 원거리 표면 (Copernicus 30m)
z = glob.glob(H + '/data/dem30/*.zip')[0]
dsm, dtr = merge([rasterio.open(f'zip://{z}!Copernicus_DSM_10_N37_00_E{e}_00_DEM.tif') for e in ('126', '127')]); dsm = dsm[0].astype('float32')
far = np.zeros((fn, fn), 'float32'); reproject(dsm, far, src_transform=dtr, src_crs=4326, dst_transform=ftr, dst_crs=5186, resampling=Resampling.bilinear)
cop = np.zeros((ny, nx), 'float32'); reproject(ndi.gaussian_filter(ndi.grey_opening(dsm, size=3), 1.0), cop, src_transform=dtr, src_crs=4326, dst_transform=ntr, dst_crs=5186, resampling=Resampling.cubic)
# ---- 지면 DTM
def verts(g, zv, step=4.0):
    g = shapely.segmentize(g.values, step); c, idx = shapely.get_coordinates(g, return_index=True); return np.c_[c, np.asarray(zv)[idx]]
t1 = H + '/work/t1000/'
sheet = gpd.read_parquet(t1 + 'sheet.parquet'); cov = sheet.geometry.union_all()
c1 = gpd.read_parquet(t1 + 'contour.parquet'); s1 = gpd.read_parquet(t1 + 'spot.parquet')
P = [verts(c1.geometry, pd.to_numeric(c1['등고수치']).values), np.c_[s1.geometry.x, s1.geometry.y, pd.to_numeric(s1['수치']).values]]
bb5 = Transformer.from_crs(5186, 5179, always_xy=True).transform_bounds(*OBM.bounds)
c5 = pyogrio.read_dataframe(T5 + '/N3L_F0010000.shp', bbox=bb5).to_crs(5186); s5 = pyogrio.read_dataframe(T5 + '/N3P_F0020000.shp', bbox=bb5).to_crs(5186)
c5 = c5[c5.CONT > 0]; c5 = c5.assign(geometry=c5.geometry.difference(cov)); c5 = c5[~c5.geometry.is_empty]
c5 = c5.explode(index_parts=False); s5 = s5[~s5.geometry.within(cov) & (s5.NUME > 0)]
P += [verts(c5.geometry, c5.CONT.values), np.c_[s5.geometry.x, s5.geometry.y, s5.NUME.values]]
P = np.vstack(P); P = P[np.isfinite(P).all(1)]
_, ui = np.unique(np.round(P[:, :2], 1), axis=0, return_index=True); P = P[ui]
print('terrain points', len(P), 'from 1:1000', len(c1), 'contours; 1:5000', len(c5), flush=True)
xs = ox0 + (np.arange(nx) + .5) * RES; ys = oy1 - (np.arange(ny) + .5) * RES
itp = LinearNDInterpolator(P[:, :2], P[:, 2]); ground = np.empty((ny, nx), 'float32')
for r0 in range(0, ny, 400):
    X, Y = np.meshgrid(xs, ys[r0:r0 + 400]); ground[r0:r0 + 400] = itp(X, Y)
nan = ~np.isfinite(ground)
if nan.any():
    rr, cc = np.nonzero(nan); _, j = cKDTree(P[:, :2]).query(np.c_[xs[cc], ys[rr]]); ground[rr, cc] = P[j, 2]
print('ground vs cop30 diff: mean %.1f sd %.1f' % (float((ground - cop).mean()), float((ground - cop).std())), 'nan filled %.2f%%' % (100 * nan.mean()), flush=True)
# ---- 피복: 0 기타 1 수면 2 숲 3 녹지
A = gpd.read_parquet(H + '/work/osm_areas.parquet').to_crs(5186); a = A[A.intersects(OB)]
cls = np.zeros((ny, nx), 'uint8')
for k, v in (('green', 3), ('forest', 2), ('water', 1)):
    s = a[a.kind == k]
    if len(s): cls = np.where(rasterize(((g, 1) for g in s.geometry.values), out_shape=(ny, nx), transform=ntr, fill=0, dtype='uint8') > 0, v, cls).astype('uint8')
w = cls == 1
if w.any():                                             # 수면 평탄화: 수면 덩어리별 가장자리 지면의 하위 5% 값
    lab, n = ndi.label(w)
    for i in range(1, n + 1):
        m = lab == i; ground[m] = max(np.percentile(ground[m], 5) - 1.0, 0.0) if m.sum() > 2000 else np.percentile(ground[m], 5)
# ---- 건물
b = gpd.read_parquet(H + '/work/buildings_seoul.parquet'); _bb = b.geometry.bounds
b = b[(_bb.maxx > ox0) & (_bb.minx < ox1) & (_bb.maxy > oy0) & (_bb.miny < oy1)].copy()
h = b.height.fillna(0).values.astype(float); fl = b.fl_up.fillna(0).values.astype(float)
ratio = np.where(fl > 0, h / np.maximum(fl, 1), np.nan); bad = (h > 0) & (fl > 0) & ((ratio > 6) | (ratio < 2.2))
b['h'] = np.where((h > 0) & ~bad, h, np.where(fl > 0, fl * FLH, 3.5)); b['hsrc'] = np.where((h > 0) & ~bad, 0, np.where(fl > 0, 1, 2))
def rast(geoms, vals): return rasterize(zip(geoms, vals), out_shape=(ny, nx), transform=ntr, fill=0, dtype='float32')
bv = b[b.hsrc < 2].sort_values('h'); bd = b[b.hsrc == 2]
bh_v = rast(bv.geometry.values, bv.h.values); bh_d = rast(bd.geometry.values, bd.h.values)
b1 = gpd.read_parquet(t1 + 'bldg.parquet'); b1['h'] = pd.to_numeric(b1['층수'], errors='coerce').fillna(1).clip(lower=1) * FLH
b1 = b1[b1.geometry.notna() & ~b1.geometry.is_empty].sort_values('h'); bh_1 = rast(b1.geometry.values, b1.h.values)
bh = np.where(bh_v > 0, bh_v, np.where(bh_1 > 0, bh_1, bh_d)).astype('float32')
n_fill = int(((bh_v == 0) & (bh_1 > 0)).sum())
tall = gpd.read_parquet(H + '/work/osm_tall.parquet'); tall = tall[tall.intersects(OB)].copy()
tall['h'] = np.where(tall.height > 0, tall.height, tall.levels * 4.0); tall = tall.sort_values('h')
bh_t = rast(tall.geometry.values, tall.h.values); fix = (bh_t > 0) & (bh < 0.6 * bh_t); bh[fix] = bh_t[fix]
bh[w] = 0; cls[bh > 0] = 0
print('bldg cells %.1f%%' % (100 * (bh > 0).mean()), '1:1000-filled cells', n_fill, 'osm-tall fixed cells', int(fix.sum()), 'max bh', float(bh.max()), flush=True)
# ---- 수목
veg = np.where(cls == 2, FOREST_H, 0).astype('float32')
tr = gpd.read_parquet(t1 + 'tree.parquet'); tr = tr[tr.geometry.notna()]
tv = rasterize(((g, 1) for g in tr.geometry.buffer(TREE_R).values), out_shape=(ny, nx), transform=ntr, fill=0, dtype='uint8') > 0
tv &= (bh == 0) & ~w; veg[tv] = np.maximum(veg[tv], TREE_H)
print('trees', len(tr), 'tree cells %.2f%%' % (100 * tv.mean()), 'forest %.1f%%' % (100 * (cls == 2).mean()), 'water %.1f%%' % (100 * w.mean()), flush=True)
# ---- 원거리 피복
fcls = np.zeros((fn, fn), 'uint8')
for k, v in (('green', 3), ('forest', 2), ('water', 1)):
    s = A[A.kind == k]; fcls = np.where(rasterize(((g, 1) for g in s.geometry.values), out_shape=(fn, fn), transform=ftr, fill=0, dtype='uint8') > 0, v, fcls).astype('uint8')
cv = rasterize([(cov, 1)], out_shape=(ny, nx), transform=ntr, fill=0, dtype='uint8')
np.savez_compressed(out + '/grids.npz', ground=ground, bh=bh, veg=veg, cls=cls, far=far, fcls=fcls, cov=cv,
                    meta=np.array([ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn, cx0, cy0, cx1, cy1]))
for nm, lo, la in (('효사정', 126.96291, 37.51054), ('사육신공원', 126.94888, 37.51382), ('용양봉저정', 126.9558, 37.51288), ('한강 수면', 126.9480, 37.5215), ('노량진역', 126.9425, 37.5142), ('63빌딩', 126.94022, 37.51982), ('파크원?', 126.9283, 37.5262)):
    x, y = T.transform(lo, la); c, r = int((x - ox0) / RES), int((oy1 - y) / RES)
    print(nm, 'ground %.1f (cop %.1f) bh %.1f veg %.0f cls %d' % (ground[r, c], cop[r, c], bh[r - 15:r + 16, c - 15:c + 16].max(), veg[r, c], cls[r, c]))
