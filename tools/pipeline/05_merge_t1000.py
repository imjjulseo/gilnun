"""1:1000 수치지형도(도엽별 SHP) -> 레이어별 병합. 출력: work/t1000/{contour,spot,bldg,tree,wall,bridge,sheet}.parquet"""
import os, sys, glob, pandas as pd, geopandas as gpd, pyogrio, warnings
warnings.filterwarnings('ignore')
src = sys.argv[1]; out = os.environ['HOME'] + '/mnt/viewapp/work/t1000'; os.makedirs(out, exist_ok=True)
L = dict(contour='N1L_F0010000', spot='N1P_F0020000', bldg='N1A_B0010000', tree='N1P_D0030000', wall='N1L_F0040000', bridge='N1A_A0070000', sheet='N1A_H0010000', overpass='N1A_C0390000', stairs='N1A_A0053326', cut='N1L_F0030000')
for k, code in L.items():
    parts = []
    for f in sorted(glob.glob(f'{src}/*/{code}.shp')):
        try:
            g = pyogrio.read_dataframe(f, encoding='cp949'); g['sheet'] = f.split('/')[-2]; parts.append(g)
        except Exception as e: print('ERR', f, e)
    if not parts: print(k, 'none'); continue
    g = pd.concat(parts, ignore_index=True); g = gpd.GeoDataFrame(g, geometry='geometry', crs=parts[0].crs)
    g.to_parquet(f'{out}/{k}.parquet'); print(k, len(g), list(g.columns)[:14])
