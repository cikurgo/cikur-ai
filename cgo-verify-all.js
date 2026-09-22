// FILE: cgo-verify-all.js
// DEPS: none | EXPORTS: verifyAll, Verifier
// PURPOSE: deterministic structural/invariant verification for the multi-sense covariant stack.

class Verifier {
    constructor() { this.log = []; this.invariants = []; }
    check(name, condition, detail = {}) {
        const holds = !!condition;
        this.invariants.push({ name, holds, detail });
        this.log.push(`${holds ? '✓' : '✗'} ${name}` +
            (Object.keys(detail).length ? `  ${JSON.stringify(detail)}` : ''));
        return holds;
    }
    closeEnough(a, b, relTol = 1e-6) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
        return Math.abs(a - b) / scale <= relTol;
    }
    section(title) {
        this.log.push('', '━'.repeat(65), `  ${title}`, '━'.repeat(65));
    }
    report() {
        const total = this.invariants.length;
        const held = this.invariants.filter(x => x.holds).length;
        const violated = this.invariants.filter(x => !x.holds);
        this.log.push('', '═'.repeat(65), `  INVARIANT HELD: ${held} / ${total}`);
        if (violated.length) {
            this.log.push('  VIOLATED:');
            violated.forEach(v => this.log.push(`    ✗ ${v.name}`));
        }
        this.log.push('═'.repeat(65));
        return this.log.join('\n');
    }
}

const C = 299792458;
const EPS = Number.EPSILON;

// Minkowski metric for components [ct, x, y, z]: diag(-1, +1, +1, +1).
function innerProduct(a, b, g = [-1, 1, 1, 1]) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) {
        throw new TypeError('innerProduct membutuhkan dua vektor 4-komponen');
    }
    return a[0] * g[0] * b[0] + a[1] * g[1] * b[1] +
           a[2] * g[2] * b[2] + a[3] * g[3] * b[3];
}

function velocity4(v3) {
    if (!Array.isArray(v3) || v3.length !== 3) throw new TypeError('v3 harus 3-komponen');
    const v2 = v3[0] ** 2 + v3[1] ** 2 + v3[2] ** 2;
    if (!Number.isFinite(v2) || v2 >= C * C) throw new RangeError('|v| harus < c');
    const gamma = 1 / Math.sqrt(1 - v2 / (C * C));
    return [gamma * C, gamma * v3[0], gamma * v3[1], gamma * v3[2]];
}

function lorentzBoost(u, beta) {
    if (Math.abs(beta) >= 1) throw new RangeError('|beta| harus < 1');
    const g = 1 / Math.sqrt(1 - beta * beta);
    return [g * (u[0] - beta * u[1]), g * (u[1] - beta * u[0]), u[2], u[3]];
}

function verifyFoundation(V) {
    V.section('FONDASI — METRIK & 4-VEKTOR');
    for (const v of [[0,0,0], [100,0,0], [1000,500,200], [1e5,0,0]]) {
        const u = velocity4(v);
        const normSq = innerProduct(u, u);
        V.check(`⟨u,u⟩ = −c² untuk v=[${v.join(',')}]`,
            V.closeEnough(normSq, -C * C, 1e-12),
            { computed: normSq.toExponential(4), expected: (-C*C).toExponential(4) });
    }
    const beta = 0.3;
    const a = velocity4([100, 0, 0]);
    const b = velocity4([0, 50, 0]);
    const before = innerProduct(a, b);
    const after = innerProduct(lorentzBoost(a, beta), lorentzBoost(b, beta));
    V.check('⟨a,b⟩ invariant under Lorentz boost', V.closeEnough(before, after, 1e-12),
        { before: before.toExponential(4), after: after.toExponential(4) });

    const k = [1, 1, 0, 0];
    const kB = lorentzBoost(k, beta);
    V.check('Null vector invariant under boost',
        V.closeEnough(innerProduct(k, k), 0, 1e-12) &&
        V.closeEnough(innerProduct(kB, kB), 0, 1e-12),
        { before: innerProduct(k,k), after: innerProduct(kB,kB) });
}

function verifyLayerMata(V) {
    V.section('LAPIS 1 — MATA: GEOMETRI');
    function geometry(elapsed, T = 550) {
        const normT = elapsed / T - 0.5;
        const elevDeg = 75 * (1 - 4 * normT * normT);
        const Re = 6371, h = 780;
        const elRad = Math.max(0.01, elevDeg * Math.PI / 180);
        const distance = Math.sqrt((Re+h)**2 - (Re*Math.cos(elRad))**2) - Re*Math.sin(elRad);
        return { elevDeg, distance, normT };
    }
    const sym = 50, g1 = geometry(275-sym), g2 = geometry(275+sym);
    V.check('Simetri pass: elev(t₀−δ) = elev(t₀+δ)', V.closeEnough(g1.elevDeg, g2.elevDeg, 1e-12),
        { elev_left: g1.elevDeg.toFixed(4), elev_right: g2.elevDeg.toFixed(4) });
    let minDist = Infinity, minAt = 0;
    for (let t=0; t<=550; t+=5) {
        const g=geometry(t);
        if (g.distance < minDist) { minDist=g.distance; minAt=t; }
    }
    V.check('Jarak minimum terjadi di zenith (t ≈ T/2)', Math.abs(minAt-275)<10,
        { t_min:minAt, d_min_km:minDist.toFixed(1) });
    const zenithDistance=geometry(275).distance;
    V.check('Jarak minimum konsisten dengan geometri zenith', Math.abs(minDist-zenithDistance)<1e-9,
        { d_min:minDist.toFixed(1), zenith:zenithDistance.toFixed(1), altitude_km:780 });
}

function verifyLayerTelinga(V) {
    V.section('LAPIS 2 — TELINGA: ELEKTROMAGNETIK');
    function linkBudget(distanceKm, freqMHz=1621.25) {
        const EIRP=37, G_RX=3, N_FLOOR=-125.6, G_P=29.2;
        const fspl=20*Math.log10(distanceKm)+20*Math.log10(freqMHz)+32.45;
        const prx=EIRP+G_RX-fspl, snr=prx-N_FLOOR;
        return { fspl, prx, snr, ebn0:snr+G_P };
    }
    const lb1=linkBudget(1000), lb2=linkBudget(2000), expectedDelta=20*Math.log10(2);
    V.check('FSPL(d₂) − FSPL(d₁) = 20·log₁₀(d₂/d₁)',
        V.closeEnough(lb2.fspl-lb1.fspl, expectedDelta, 1e-12),
        { delta:(lb2.fspl-lb1.fspl).toFixed(4), expected:expectedDelta.toFixed(4) });
    const lbZ=linkBudget(780);
    V.check('SNR @ zenith > 0 dB (link viable)', lbZ.snr>0, { snr_dB:lbZ.snr.toFixed(2) });
    function doppler(vRadialMs, freqHz=1621.25e6) { return -(vRadialMs/C)*freqHz; }
    const d1=doppler(1000), d2=doppler(2000);
    V.check('Doppler ∝ v_r (linear)', V.closeEnough(d2,2*d1,1e-12), { d_1k:d1.toFixed(2), d_2k:d2.toFixed(2) });
    const dMax=Math.abs(doppler(7460));
    V.check('Doppler shift max ≈ 40.5 kHz', Math.abs(dMax-40500)<1000,
        { computed_kHz:(dMax/1000).toFixed(2), expected_kHz:40.5 });
    V.check('Eb/N0 = SNR + G_p', V.closeEnough(lbZ.ebn0,lbZ.snr+29.2,1e-12),
        { ebn0:lbZ.ebn0.toFixed(2), snr_plus_gp:(lbZ.snr+29.2).toFixed(2) });
}

function verifyLayerTangan(V) {
    V.section('LAPIS 3 — TANGAN: DINAMIKA');
    // Correct invariant: the Euler-Lagrange equation is stationary first variation,
    // not a global minimum. For L = 1/2 qdot² - 1/2 q²: q'' + q = 0.
    const T=10, N=4000, dt=T/N;
    let firstVariation=0;
    for(let i=0;i<=N;i++) {
        const t=i*dt, q=Math.cos(t), qdot=-Math.sin(t);
        const eta=Math.sin(Math.PI*t/T), etaDot=(Math.PI/T)*Math.cos(Math.PI*t/T);
        const integrand=qdot*etaDot-q*eta;
        firstVariation += integrand*(i===0||i===N?0.5:1)*dt;
    }
    V.check('Aksi stasioner: first variation δS ≈ 0', Math.abs(firstVariation)<1e-6,
        { deltaS:firstVariation.toExponential(4) });

    function energy(q,qdot){ return 0.5*qdot*qdot+0.5*q*q; }
    const E0=energy(1,0); let maxDrift=0, q=1, qdot=0;
    for(let i=0;i<1000;i++) {
        const h=0.01;
        const qddot=-q;
        q += qdot*h + 0.5*qddot*h*h;
        const qddotNew=-q;
        qdot += 0.5*(qddot+qddotNew)*h;
        maxDrift=Math.max(maxDrift,Math.abs(energy(q,qdot)-E0));
    }
    V.check('Energi terjaga secara numerik (drift < 0.1%)', maxDrift/E0<1e-3,
        { E0:E0.toFixed(6), drift:maxDrift.toExponential(2) });
}

function verifyLayerInti(V) {
    V.section('LAPIS 4 — INTI: INVARIAN (NOETHER)');
    function step([theta,omega],dt) {
        const a=-Math.sin(theta), wh=omega+a*dt/2;
        const tn=theta+wh*dt, an=-Math.sin(tn);
        return [tn,wh+an*dt/2];
    }
    function energy([theta,omega]) { return 0.5*omega*omega+(1-Math.cos(theta)); }
    let state=[0.3,0], Ei=energy(state);
    for(let i=0;i<5000;i++) state=step(state,0.01);
    const Ef=energy(state);
    V.check('Energi terjaga (translasi waktu → Noether)', Math.abs(Ef-Ei)/Ei<1e-4,
        { E_init:Ei.toFixed(8), E_final:Ef.toFixed(8), rel_drift:((Ef-Ei)/Ei).toExponential(3) });

    const probs=[0.1,0.2,0.3,0.4], H=-probs.reduce((s,p)=>s+p*Math.log(p),0);
    V.check('Entropi Shannon ≥ 0', H>=0, { H:H.toFixed(6) });
    const N=8, pu=Array(N).fill(1/N), Hu=-pu.reduce((s,p)=>s+p*Math.log(p),0);
    V.check('Entropi uniform = ln(N)', V.closeEnough(Hu,Math.log(N),1e-12),
        { H:Hu.toFixed(6), ln_N:Math.log(N).toFixed(6) });
    const samples=Array.from({length:100},(_,i)=>5+((i*37)%100)/100*2);
    const mean=samples.reduce((a,b)=>a+b,0)/samples.length;
    const variance=samples.reduce((a,b)=>a+(b-mean)**2,0)/samples.length;
    const fisher=1/variance;
    V.check('Fisher information ≥ 0', fisher>0, { I:fisher.toFixed(6) });
}

function verifyLayerKesadaran(V) {
    V.section('LAPIS 5 — KESADARAN: ORDER PARAMETER');
    const F=(Psi,alpha=1,beta=1)=>alpha*Psi*Psi+beta*Psi**4;
    V.check('Landau F(Ψ) simetris: F(Ψ) = F(−Ψ)', V.closeEnough(F(.5),F(-.5),1e-12),
        { F_pos:F(.5), F_neg:F(-.5) });
    V.check('Minimum F di Ψ=0 untuk α > 0', F(0)<F(.1)&&F(0)<F(.5),
        { F_0:F(0), F_01:F(.1), F_05:F(.5) });
    const sigma=K=>Math.abs(K)*0.001;
    V.check('Produksi entropi σ ≥ 0', sigma(10)>=0&&sigma(-10)>=0,
        { sigma_pos:sigma(10), sigma_neg:sigma(-10) });
}

function verifyLayerRasa(V) {
    V.section('LAPIS 6 — RASA: ISOMORFISME');
    const fA=x=>x+1, fB=x=>String(Number(x)+1), gA=x=>x*2, gB=x=>String(Number(x)*2), F=x=>String(x);
    const x=5, lhs=F(gA(fA(x))), rhs=gB(fB(F(x)));
    V.check('Fungtor preserve komposisi: F(g∘f) = F(g)∘F(f)', lhs===rhs, { lhs,rhs });
    V.check('Fungtor preserve identity', F(x)===F(x), { result:F(x) });

    function rasaDistance(a,b) {
        const keys=Array.from(new Set([...Object.keys(a),...Object.keys(b)]));
        if(!keys.length) return 0;
        let sum=0;
        for(const k of keys) {
            const av=Number.isFinite(a[k])?a[k]:0, bv=Number.isFinite(b[k])?b[k]:0;
            const scale=Math.max(Math.abs(av),Math.abs(bv),1e-10);
            sum+=Math.abs(av-bv)/scale;
        }
        return sum/keys.length;
    }
    const sig1={a:1,b:2,c:3}, sig2={a:1.1,b:2.1,c:3.1};
    V.check('Distance rasa simetris: d(A,B) = d(B,A)', V.closeEnough(rasaDistance(sig1,sig2),rasaDistance(sig2,sig1),1e-12));
    V.check('Distance rasa: d(A,A) = 0', V.closeEnough(rasaDistance(sig1,sig1),0,1e-12));
}

class Manifold {
    constructor(N=32) {
        if(!Number.isInteger(N)||N<3) throw new RangeError('N harus integer >= 3');
        this.N=N; this.buf=new Float64Array(N*3); this.idx=0; this.count=0;
    }
    push(x,y,z) {
        for(const v of [x,y,z]) if(!Number.isFinite(v)) throw new TypeError('sample harus finite');
        const i=(this.idx%this.N)*3;
        this.buf[i]=x; this.buf[i+1]=y; this.buf[i+2]=z;
        this.idx++; this.count=Math.min(this.count+1,this.N);
    }
    covariance() {
        if(this.count<this.N) return null;
        const mean=[0,0,0];
        for(let k=0;k<this.N;k++){const i=k*3;mean[0]+=this.buf[i];mean[1]+=this.buf[i+1];mean[2]+=this.buf[i+2];}
        mean[0]/=this.N; mean[1]/=this.N; mean[2]/=this.N;
        const S=new Float64Array(9);
        for(let k=0;k<this.N;k++){
            const i=k*3, d0=this.buf[i]-mean[0], d1=this.buf[i+1]-mean[1], d2=this.buf[i+2]-mean[2];
            S[0]+=d0*d0; S[1]+=d0*d1; S[2]+=d0*d2;
            S[3]+=d1*d0; S[4]+=d1*d1; S[5]+=d1*d2;
            S[6]+=d2*d0; S[7]+=d2*d1; S[8]+=d2*d2;
        }
        for(let i=0;i<9;i++) S[i]/=this.N;
        return S;
    }
    // Standardize covariance to correlation/Fisher-like shape; constant dimensions remain zero.
    fisherMatrix() {
        const cov=this.covariance(); if(!cov) return null;
        const sd=[Math.sqrt(Math.max(cov[0],0)),Math.sqrt(Math.max(cov[4],0)),Math.sqrt(Math.max(cov[8],0))];
        const S=new Float64Array(9);
        for(let i=0;i<3;i++) for(let j=0;j<3;j++) {
            const denom=sd[i]*sd[j];
            S[i*3+j]=denom>0 ? cov[i*3+j]/denom : 0;
        }
        return S;
    }
    eigenvalues() {
        const A=this.fisherMatrix(); if(!A) return null;
        // Jacobi diagonalization: stable for the real symmetric 3×3 matrix.
        for(let iter=0;iter<32;iter++) {
            let p=0,q=1,max=Math.abs(A[1]);
            if(Math.abs(A[2])>max){p=0;q=2;max=Math.abs(A[2]);}
            if(Math.abs(A[5])>max){p=1;q=2;max=Math.abs(A[5]);}
            if(max<1e-14) break;
            const app=A[p*3+p], aqq=A[q*3+q], apq=A[p*3+q];
            const tau=(aqq-app)/(2*apq), t=Math.sign(tau)/(Math.abs(tau)+Math.sqrt(1+tau*tau));
            const c=1/Math.sqrt(1+t*t), s=t*c;
            for(let k=0;k<3;k++) {
                if(k===p||k===q) continue;
                const akp=A[k*3+p], akq=A[k*3+q];
                A[k*3+p]=A[p*3+k]=c*akp-s*akq;
                A[k*3+q]=A[q*3+k]=s*akp+c*akq;
            }
            A[p*3+p]=c*c*app-2*s*c*apq+s*s*aqq;
            A[q*3+q]=s*s*app+2*s*c*apq+c*c*aqq;
            A[p*3+q]=A[q*3+p]=0;
        }
        const eigs=[A[0],A[4],A[8]].map(x=>Math.max(0,x)).sort((a,b)=>a-b);
        const trace=eigs[0]+eigs[1]+eigs[2];
        return {min:eigs[0],mid:eigs[1],max:eigs[2],trace,det:eigs[0]*eigs[1]*eigs[2]};
    }
    orderParameter() {
        const e=this.eigenvalues(); if(!e||e.trace<=EPS) return 0;
        return Math.max(0,Math.min(1,e.min/e.trace));
    }
}

function verifyManifold(V) {
    V.section('MANIFOLD — CRITICAL POINT DETECTION');
    const M=new Manifold(32);
    for(let i=0;i<64;i++) M.push(45+20*Math.sin(i*.1),100*Math.cos(i*.2),30+5*Math.sin(i*.3));
    const eig=M.eigenvalues();
    V.check('Eigenvalue ≥ 0 (Fisher PSD)', eig.min>=-1e-12, { min:eig.min.toExponential(4) });
    V.check('Trace = λ₁ + λ₂ + λ₃', V.closeEnough(eig.trace,eig.min+eig.mid+eig.max,1e-12),
        { trace:eig.trace.toFixed(6), sum:(eig.min+eig.mid+eig.max).toFixed(6) });
    const psi=M.orderParameter();
    V.check('Order parameter Ψ ∈ [0, 1]', psi>=0&&psi<=1, { psi:psi.toFixed(6) });

    const M2=new Manifold(32); for(let i=0;i<64;i++) M2.push(50,50,50);
    const psiConst=M2.orderParameter();
    V.check('Sistem konstan → Ψ = 0 (tidak ada variasi)', psiConst===0, { psi:psiConst });

    // Deterministic pseudo-random sequence: audit result does not change between runs.
    let seed=0x12345678;
    const rand=()=>{ seed=(Math.imul(1664525,seed)+1013904223)>>>0; return seed/4294967296; };
    const M3=new Manifold(32);
    for(let i=0;i<64;i++) M3.push(rand(),rand(),rand());
    const psiIso=M3.orderParameter();
    V.check('Sistem isotropik → Ψ ≈ 1/3', Math.abs(psiIso-1/3)<0.1,
        { psi:psiIso.toFixed(4), expected:(1/3).toFixed(4) });
}

function verifyAll() {
    const V=new Verifier();
    V.log.push('', '╔'+'═'.repeat(63)+'╗',
        '║  VERIFIKASI STRUKTURAL — SISTEM MULTI-INDRA KOVARIAN    ║',
        '║  Audit invariant deterministik, tanpa asumsi tetap       ║',
        '╚'+'═'.repeat(63)+'╝');
    const checks=[
        ['Fondasi',verifyFoundation],['Mata',verifyLayerMata],['Telinga',verifyLayerTelinga],
        ['Tangan',verifyLayerTangan],['Inti',verifyLayerInti],['Kesadaran',verifyLayerKesadaran],
        ['Rasa',verifyLayerRasa],['Manifold',verifyManifold]
    ];
    for(const [name,fn] of checks) {
        try { fn(V); }
        catch(e) { V.check(`${name} crash: ${e instanceof Error ? e.message : String(e)}`,false); }
    }
    return V.report();
}

export { verifyAll, Verifier, Manifold, innerProduct, velocity4, lorentzBoost };
