"""파일럿 계산 결과 -> 앱 데이터(public/data). 데이터를 갈아끼울 때는 이 스크립트만 다시 돌리고 manifest 버전을 올린다."""
import sys, json, numpy as np, pandas as pd, geopandas as gpd, shapely
U='/mnt/user-data/uploads/viewapp'; OUT='/home/claude/gilnun/app/public/data'
D=pd.read_parquet(f'{U}/work/pilot/scored.parquet'); L=gpd.read_parquet(f'{U}/work/walknet_links.parquet')
D['open']=(0.25*D.s_sky+0.20*D.s_depth+0.15*D.s_pano)/0.60
g=D.groupby('link').agg(sky=('open','mean'),water=('s_water','mean'),green=('s_nature','mean'),calm=('f_calm','mean'),n=('x','size'),zone=('zone','first'),deck=('deck','max'),
                        csky=('c_sky','mean'),cwater=('c_water','mean'),cnat=('c_nat','mean'),pano=('pano300','mean'),gz=('gz','mean'),dong=('dong','first'))
L=L[L.link.isin(g.index)].drop_duplicates('link')[['link','geometry']].set_index('link').join(g,how='inner')
L=L.set_geometry(shapely.simplify(L.geometry.values,1.0)).to_crs(4326)
q=lambda s:(np.clip(s,0,1)*100).round().astype(int)
feats=[]
for r in L.itertuples():
    co=[[round(x,6),round(y,6)] for x,y in r.geometry.coords]
    feats.append(dict(type='Feature',id=int(r.Index),geometry=dict(type='LineString',coordinates=co),
        properties=dict(k=q(r.sky).item(),w=q(r.water).item(),g=q(r.green).item(),c=int(round(min(r.calm,1.15)*100)),
                        ps=int(round(r.csky*100)),pw=round(float(r.cwater)*100,1),pg=int(round(r.cnat*100)),pa=int(round(r.pano)),z=int(round(r.gz)),r=1 if r.zone=='river' else 0)))
json.dump(dict(type='FeatureCollection',features=feats),open(f'{OUT}/pilot/links.json','w'),separators=(',',':'))
S=pd.read_csv(f'{U}/out/pilot_spots.csv'); spots=[]
for r in S.itertuples():
    kind='물' if r.water>=0.01 else ('녹지' if 'nature' in r.why else '하늘')
    spots.append(dict(id=f'p{r.rank}',rank=int(r.rank),lat=r.lat,lon=r.lon,dong=r.dong,title=f"{r.dong} {'언덕길' if r.ground_m>=45 else '트인 길'}",kind=kind,
                      sky=int(round(r.sky*100)),water=round(r.water*100,1),pano=int(r.pano300),elev=int(round(r.ground_m)),top=round(100-r.pct_inland,1),prom=int(round(r.prominence)),calm=bool(r.calm)))
json.dump(spots,open(f'{OUT}/pilot/spots.json','w'),ensure_ascii=False,separators=(',',':'))
b=L.total_bounds
json.dump(dict(version='2026-11-16.pilot2',note='임시 가중치. 지형 1:5000 등고선, 수목 일부 반영',regions=[dict(id='pilot',name='노량진, 본동',bbox=[round(v,5) for v in b],center=[126.9445,37.5125],zoom=14.6,
          links='pilot/links.json',spots='pilot/spots.json')]),open(f'{OUT}/manifest.json','w'),ensure_ascii=False,indent=1)
import os; print(len(feats),len(spots),os.path.getsize(f'{OUT}/pilot/links.json')//1024,'KB'); print(S[['dong','ground_m','water','why']].head(8).to_string())
print(L[['sky','water','green','calm']].describe().round(2).to_string())
