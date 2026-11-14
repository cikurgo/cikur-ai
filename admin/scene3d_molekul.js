// Molekul 3D — blok ```scene3d``` (Three.js r128). Global: THREE, scene, camera, renderer, onFrame.
const g = new THREE.Group(); scene.add(g);
const core = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 24), new THREE.MeshNormalMaterial());
g.add(core);
const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.15, 0.05, 160, 10, 2, 3),
  new THREE.MeshBasicMaterial({ color: 0x7c4dff, wireframe: true }));
g.add(knot);
const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.025, 12, 128), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
ring.rotation.x = Math.PI / 2; g.add(ring);
const cols = [0x38bdf8, 0x10b981, 0xf59e0b, 0xf43f5e], atoms = [], bonds = [];
for (let i = 0; i < 4; i++) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), new THREE.MeshBasicMaterial({ color: cols[i] }));
  g.add(m); atoms.push(m);
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
  g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x94a3b8 }))); bonds.push(geo);
}
onFrame((t, dt) => {
  g.rotation.y += dt * 0.35;
  knot.rotation.x += dt * 0.5; knot.rotation.y += dt * 0.8;
  core.scale.setScalar(1 + 0.06 * Math.sin(t * 2));
  for (let i = 0; i < 4; i++) {
    const a = t * (0.8 - i * 0.12) + i * 1.57, R = 1.5 + (i % 2) * 0.4, p = atoms[i].position;
    p.set(Math.cos(a) * R, Math.sin(a * 0.7 + i) * 0.7, Math.sin(a) * R);
    const pa = bonds[i].attributes.position; pa.setXYZ(1, p.x, p.y, p.z); pa.needsUpdate = true;
  }
});
