"""Motion maths shared by asset placement and animation. Pure Python + mathutils, no scene access.

Conventions: Z up. A heading is an angle in radians from +X, counter-clockwise (so +Y is pi/2). Vehicle models
are imported with their own forward axis (manifest "forward"); root_yaw() converts a heading to the yaw to give the
vehicle's root so its nose points along that heading.
"""
import bisect
import math

from mathutils import Matrix, Vector

MAX_SLIP = math.radians(42)  # drift amount 1.0 = this angle between body and direction of travel
FORWARD = {"+X": (1.0, 0.0), "-X": (-1.0, 0.0), "+Y": (0.0, 1.0), "-Y": (0.0, -1.0)}


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def wrap_pi(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def root_yaw(heading, forward):
    """Yaw to give a root whose model nose points along `forward` (e.g. "-Y") so the nose faces `heading`."""
    fx, fy = FORWARD[forward]
    return heading - math.atan2(fy, fx)


class PolyPath:
    """A polyline in XY parameterised by arc length."""

    def __init__(self, pts):
        self.pts = [(float(p[0]), float(p[1])) for p in pts]
        self.cum = [0.0]
        for i in range(1, len(self.pts)):
            self.cum.append(self.cum[-1] + math.hypot(self.pts[i][0] - self.pts[i - 1][0], self.pts[i][1] - self.pts[i - 1][1]))
        self.length = self.cum[-1]

    def pos(self, s):
        s = max(0.0, min(self.length, s))
        i = max(1, min(len(self.pts) - 1, bisect.bisect_left(self.cum, s)))
        seg = self.cum[i] - self.cum[i - 1]
        u = 0.0 if seg == 0 else (s - self.cum[i - 1]) / seg
        return (self.pts[i - 1][0] + (self.pts[i][0] - self.pts[i - 1][0]) * u,
                self.pts[i - 1][1] + (self.pts[i][1] - self.pts[i - 1][1]) * u)

    def heading(self, s, window=1.5):
        a, b = self.pos(s - window), self.pos(s + window)
        if abs(a[0] - b[0]) + abs(a[1] - b[1]) < 1e-9:
            a, b = self.pts[0], self.pts[-1]
        return math.atan2(b[1] - a[1], b[0] - a[0])


class Trajectory:
    """Where an actor is at time t: position on the ground, direction of travel, distance travelled and speed.

    spec: {"kind": "named", "points": [[x, y], ...], "speed": m/s, "start": m, "action": name}
          {"kind": "timed", "points": [{"at": s, "x": m, "y": m}, ...]}
    """

    def __init__(self, spec, duration):
        self.duration = float(duration)
        self.kind = spec["kind"]
        if self.kind == "named":
            self.path = PolyPath(spec["points"])
            self.speed = float(spec["speed"])
            self.start = float(spec.get("start", 0.0))
            self.action = spec.get("action", "drive")
        else:
            pts = sorted(spec["points"], key=lambda p: p["at"])
            self.timed = [(p["at"], p["x"], p["y"]) for p in pts]
            # Arc length of the timed polyline, so heading and distance use the same machinery.
            self.path = PolyPath([(x, y) for _, x, y in self.timed])
            self.speed = 0.0
            self.start = 0.0
            self.action = "drive"

    def _dist_named(self, t):
        T = max(self.duration, 1e-6)
        v = self.speed
        if self.action == "idle":
            return self.start
        if self.action == "brake":
            return self.start + v * (t - t * t / (2 * T))
        if self.action == "launch":
            return self.start + v * t * t / (2 * T)
        return self.start + v * t

    def _speed_named(self, t):
        T = max(self.duration, 1e-6)
        if self.action == "idle":
            return 0.0
        if self.action == "brake":
            return self.speed * (1 - t / T)
        if self.action == "launch":
            return self.speed * t / T
        return self.speed

    def _s_timed(self, t):
        """Arc-length position along the timed polyline at time t (linear in time between waypoints)."""
        pts = self.timed
        if t <= pts[0][0]:
            return 0.0
        for i in range(1, len(pts)):
            if t <= pts[i][0]:
                u = (t - pts[i - 1][0]) / max(pts[i][0] - pts[i - 1][0], 1e-9)
                return self.path.cum[i - 1] + (self.path.cum[i] - self.path.cum[i - 1]) * u
        return self.path.length

    def at(self, t):
        if self.kind == "named":
            s = max(0.0, min(self.path.length, self._dist_named(t)))
            speed = self._speed_named(t)
        else:
            s = self._s_timed(t)
            speed = (self._s_timed(t + 0.05) - self._s_timed(max(0.0, t - 0.05))) / 0.1
        x, y = self.path.pos(s)
        return {"x": x, "y": y, "heading": self.path.heading(s), "dist": s, "speed": speed,
                "curvature": wrap_pi(self.path.heading(s + 2.0) - self.path.heading(s - 2.0)) / 4.0}

    def slip_sign(self):
        """+1 if the path turns left overall, -1 if right; straight paths drift with the nose to the left."""
        total = 0.0
        n = 20
        prev = self.at(0.0)["heading"]
        for i in range(1, n + 1):
            h = self.at(self.duration * i / n)["heading"]
            total += wrap_pi(h - prev)
            prev = h
        return -1.0 if total < -0.05 else 1.0


def pose(traj, t, drift, slip_sign, forward):
    """Full pose of a vehicle at time t."""
    st = traj.at(t)
    ramp = smoothstep(t / 0.4)  # the slide builds over 0.4 s instead of snapping
    slip = drift * MAX_SLIP * ramp if st["speed"] > 0.5 else 0.0
    body_heading = st["heading"] + slip_sign * slip
    st.update({"slip": slip, "bodyHeading": body_heading, "rootYaw": root_yaw(body_heading, forward), "t": t})
    return st


def ground_z(plane, x, y):
    return plane[0] * x + plane[1] * y + plane[2]


def heading_vec(h):
    return Vector((math.cos(h), math.sin(h), 0.0))


def look_matrix(position, target, up_hint=Vector((0.0, 0.0, 1.0)), roll_deg=0.0):
    """Camera rotation matrix: -Z looks at `target`, +Y is as close to `up_hint` as possible, then rolled about the view axis."""
    z = (position - target).normalized()
    x = up_hint.cross(z)
    if x.length < 1e-6:
        x = Vector((1.0, 0.0, 0.0)).cross(z)
    x.normalize()
    y = z.cross(x)
    m = Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z)))
    if roll_deg:
        m = m @ Matrix.Rotation(math.radians(roll_deg), 3, "Z")
    return m
