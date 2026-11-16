"""보행망 10m 샘플점별 가시성 계산 (numba). 사용: python 03_viewshed.py [eye_height]
출력: work/pilot/points_e{eye}.parquet (+ hz/df npy: 방위각별 지평선 고도각, 최원 가시거리)"""
import os, sys, math, numpy as np, geopandas as gpd, pandas as pd, shapely, time
from numba import njit, prange
H = os.environ['HOME'] + '/mnt/viewapp'; P = H + '/work/pilot'
EYE = float(sys.argv[1]) if len(sys.argv) > 1 else 1.6
G = np.load(P + '/grids.npz')
ground, bh, veg, cls, far, fcls = G['ground'], G['bh'], G['veg'], G['cls'], G['far'], G['fcls']
ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn, cx0, cy0, cx1, cy1 = G['meta']; nx, ny, fn = int(nx), int(ny), int(fn)
surf = ground + np.maximum(bh, veg)
surfb = ground + bh                                   # 수목 제외 표면 (근접 25m 이내는 수관 아래로 시야가 통한다고 가정)
VEG_NEAR = 25.0
ncls = np.where(bh > 0, 4, cls).astype(np.uint8)          # 0 기타 1 수면 2 숲 3 녹지 4 건물
NAZ, LO, HI, KR = 360, math.radians(-15), math.radians(25), (1 - 0.13) / (2 * 6371000.0)
MAXD = 30000.0
LM = [('n_tower', 126.99107, 37.55109, 243.0, 479.7), ('b63', 126.94022, 37.51982, 12.0, 262.0), ('lotte', 127.10268, 37.51255, 15.0, 570.0)]
from pyproj import Transformer
T = Transformer.from_crs(4326, 5186, always_xy=True)
lmx = np.array([[*T.transform(l[1], l[2]), l[3], l[4]] for l in LM])

@njit(cache=True)
def sample(x, y, d, surf, surfb, ncls, far, fcls, ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn):
    c = int((x - ox0) / RES); r = int((oy1 - y) / RES)
    if 0 <= c < nx and 0 <= r < ny:
        if d < VEG_NEAR: return surfb[r, c], (ncls[r, c] if ncls[r, c] != 2 else 3), 1
        return surf[r, c], ncls[r, c], 1
    c = int((x - fx0) / FRES); r = int((fy1 - y) / FRES)
    if 0 <= c < fn and 0 <= r < fn: return far[r, c], fcls[r, c], 2
    return 0.0, 0, 0

@njit(parallel=True, cache=True)
def run(px, py, pz, surf, surfb, ncls, far, fcls, ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn, lmx):
    n = px.shape[0]
    hz = np.zeros((n, NAZ), np.float32); df = np.zeros((n, NAZ), np.float32)
    comp = np.zeros((n, 6), np.float32)        # sky, water, forest, green, building, other
    waz = np.zeros(n, np.float32); lm = np.zeros((n, lmx.shape[0]), np.float32)
    for i in prange(n):
        x0, y0, z0 = px[i], py[i], pz[i]
        for a in range(NAZ):
            th = math.radians(a + 0.5); dx = math.sin(th); dy = math.cos(th)
            d = 2.0; mx = -1.5; dfar = 0.0; wat = 0.0
            while d < MAXD:
                zs, k, src = sample(x0 + dx * d, y0 + dy * d, d, surf, surfb, ncls, far, fcls, ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn)
                if src == 0: break
                ang = math.atan2(zs - d * d * KR - z0, d)
                if ang > mx:
                    lo = mx if mx > LO else LO; hi = ang if ang < HI else HI
                    if hi > lo:
                        j = 5
                        if k == 1: j = 1; wat += hi - lo
                        elif k == 2: j = 2
                        elif k == 3: j = 3
                        elif k == 4: j = 4
                        comp[i, j] += hi - lo
                    mx = ang; dfar = d
                st = 0.005 * d
                mn = RES if src == 1 else FRES
                d += st if st > mn else mn
            if mx < HI: comp[i, 0] += HI - (mx if mx > LO else LO)
            hz[i, a] = mx; df[i, a] = dfar
            if wat > 0.002: waz[i] += 1
        for q in range(lmx.shape[0]):
            ddx = lmx[q, 0] - x0; ddy = lmx[q, 1] - y0; D = math.sqrt(ddx * ddx + ddy * ddy)
            if D < 150 or D > 40000: continue
            ux = ddx / D; uy = ddy / D; d = 2.0; mx = -1.5
            while d < D - 80:
                zs, k, src = sample(x0 + ux * d, y0 + uy * d, d, surf, surfb, ncls, far, fcls, ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn)
                if src == 0: break
                ang = math.atan2(zs - d * d * KR - z0, d)
                if ang > mx: mx = ang
                st = 0.005 * d; mn = RES if src == 1 else FRES
                d += st if st > mn else mn
            ab = math.atan2(lmx[q, 2] - D * D * KR - z0, D); at = math.atan2(lmx[q, 3] - D * D * KR - z0, D)
            v = (at - (mx if mx > ab else ab)) / (at - ab)
            lm[i, q] = 0.0 if v < 0 else (1.0 if v > 1 else v)
    return hz, df, comp, waz, lm

def make_points():
    """도보 네트워크 링크를 10m 간격으로 샘플. 터널·지하·건물내 제외. 교량/고가/육교는 상판 높이 근사."""
    L = gpd.read_parquet(H + '/work/walknet_links.parquet')
    bb = L.geometry.bounds; L = L[(bb.maxx > cx0) & (bb.minx < cx1) & (bb.maxy > cy0) & (bb.miny < cy1)]
    L = L[~(L.tunnel | L.subway | L.indoor)]
    rows = []
    for r in L.itertuples():
        g = r.geometry; ln = g.length; ds = np.arange(5.0, ln, 10.0) if ln > 10 else np.array([ln / 2])
        pts = shapely.line_interpolate_point(g, ds)
        cs = np.asarray(g.coords); e = []
        for xx, yy in (cs[0], cs[-1]):
            cc = min(max(int((xx - ox0) / RES), 0), nx - 1); rr = min(max(int((oy1 - yy) / RES), 0), ny - 1); e.append(ground[rr, cc])
        for d, p in zip(ds, pts): rows.append((r.link, r.gu, r.dong, r.bridge, r.elevated, r.overpass, r.park, r.crosswalk, e[0] * (1 - d / ln) + e[1] * d / ln, p.x, p.y))
    D = pd.DataFrame(rows, columns=['link', 'gu', 'dong', 'bridge', 'elevated', 'overpass', 'park', 'crosswalk', 'zlin', 'x', 'y'])
    D = D[(D.x > cx0) & (D.x < cx1) & (D.y > cy0) & (D.y < cy1)].reset_index(drop=True)
    c = ((D.x.values - ox0) / RES).astype(int); r = ((oy1 - D.y.values) / RES).astype(int)
    D['gz'] = ground[r, c]; D['inb'] = bh[r, c] > 0; D['onwater'] = cls[r, c] == 1
    deck = D.bridge | D.elevated | D.overpass
    z = np.where(deck, np.maximum(D.zlin, D.gz), D.gz)
    z = np.where(D.overpass, z + 5.0, z); z = np.where((D.bridge | D.elevated) & D.onwater, np.maximum(z, 16.0), z)   # 한강 교량 상판 최소 16m 가정
    D['gz'] = z; D['deck'] = deck
    n0 = len(D); D = D[~D.inb | deck].reset_index(drop=True); print('dropped in-building', n0 - len(D))
    return D

if __name__ == '__main__':
    t0 = time.time(); D = make_points(); print('points', len(D), 'deck', int(D.deck.sum()), round(time.time() - t0, 1), flush=True)
    part, npart = int(os.environ.get('PART', '0')), int(os.environ.get('NPART', '1'))
    D = D.iloc[part::npart].reset_index(drop=True)
    lim = int(os.environ.get('LIMIT', '0'))
    if lim: D = D.sample(lim, random_state=0).reset_index(drop=True)
    px, py, pz = D.x.values.astype(np.float64), D.y.values.astype(np.float64), (D.gz.values + EYE).astype(np.float64)
    t0 = time.time()
    hz, df, comp, waz, lm = run(px, py, pz, surf, surfb, ncls, far, fcls, ox0, oy1, RES, nx, ny, fx0, fy1, FRES, fn, lmx)
    print('run sec', round(time.time() - t0, 1), flush=True)
    comp /= (NAZ * (HI - LO))
    hzp = np.maximum(hz, 0); D['svf'] = (np.cos(hzp) ** 2).mean(1)
    for j, nm in enumerate(['sky', 'water', 'forest', 'green', 'bldg', 'other']): D['c_' + nm] = comp[:, j]
    D['water_az'] = waz; D['d_med'] = np.median(df, 1); D['d_p90'] = np.percentile(df, 90, 1)
    far1 = df >= 1000; dbl = np.concatenate([far1, far1], 1); best = np.zeros(len(D), int); cur = np.zeros(len(D), int)
    for a in range(2 * NAZ): cur = np.where(dbl[:, a], cur + 1, 0); best = np.maximum(best, cur)
    D['pano'] = np.minimum(best, NAZ)
    D['west_open'] = np.degrees(hz[:, 240:300].mean(1))
    for q, l in enumerate(LM): D['lm_' + l[0]] = lm[:, q]
    lon, lat = Transformer.from_crs(5186, 4326, always_xy=True).transform(D.x.values, D.y.values); D['lon'] = lon; D['lat'] = lat
    tag = ('%.1f' % EYE).replace('.', '_') + ('_s' if lim else '') + f'_p{part}of{npart}'
    D.to_parquet(P + f'/points_e{tag}.parquet'); np.save(P + f'/hz_e{tag}.npy', hz.astype(np.float16)); np.save(P + f'/df_e{tag}.npy', df)
    print(D[['svf', 'c_sky', 'c_water', 'c_forest', 'c_green', 'c_bldg', 'd_med', 'd_p90', 'pano', 'water_az', 'lm_n_tower', 'lm_b63', 'lm_lotte']].describe().T[['mean', '50%', 'max']].round(3).to_string())
