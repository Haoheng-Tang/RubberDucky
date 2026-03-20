#include <Servo.h>

#ifndef LINKAGE_SOLVER_H
#define LINKAGE_SOLVER_H

#include <math.h>

struct Vec2 {
  float x, y;
};

struct LinkageLengths {
  float AB;
  float BC;
  float CD;
  float DA;
  float BE;
  float CE;
};

struct LinkageSides {
  int8_t fwd_C;
  int8_t fwd_E;
  int8_t inv_B;
  int8_t inv_C;
  int8_t inv_D;
};

struct ForwardResult {
  bool valid;
  Vec2 B, C, D, E;
};

struct InverseResult {
  bool valid;
  float theta1;
  float theta2;
  Vec2 B, C, D;
};


// ------------------------------------------------------------
// Math helpers
// ------------------------------------------------------------

// Cross product sign: which side of line c1→c2 is point p on?
// +1 = left, -1 = right, 0 = collinear
static int8_t crossSign(Vec2 c1, Vec2 c2, Vec2 p) {
  float v = (c2.x - c1.x) * (p.y - c1.y) -
            (c2.y - c1.y) * (p.x - c1.x);

  if (v > 0.0f) return 1;
  if (v < 0.0f) return -1;
  return 0;
}


// JS-equivalent circle-circle intersection
static bool circleIntersect(Vec2 c1, float r1,
                            Vec2 c2, float r2,
                            Vec2 &out1, Vec2 &out2) {

  float dx = c2.x - c1.x;
  float dy = c2.y - c1.y;
  float d = sqrtf(dx * dx + dy * dy);

  // JS tolerance replicated
  if (d > r1 + r2 + 0.5f ||
      d < fabsf(r1 - r2) - 0.5f ||
      d < 1e-6f)
    return false;

  float a = (r1 * r1 - r2 * r2 + d * d) / (2.0f * d);
  float h = sqrtf(fmaxf(0.0f, r1 * r1 - a * a));

  float mx = c1.x + a * dx / d;
  float my = c1.y + a * dy / d;

  out1 = { mx + h * dy / d, my - h * dx / d };
  out2 = { mx - h * dy / d, my + h * dx / d };

  return true;
}


// Pick intersection on desired side of line c1→c2
// Matches JS logic exactly.
static Vec2 pickBySide(Vec2 p1, Vec2 p2,
                       Vec2 c1, Vec2 c2,
                       int8_t side) {

  if (crossSign(c1, c2, p1) == side)
    return p1;
  else
    return p2;
}


// ------------------------------------------------------------
// Chirality
// ------------------------------------------------------------

// Compute chirality from an existing valid configuration
static LinkageSides computeSides(Vec2 A, Vec2 B, Vec2 C, Vec2 D, Vec2 E) {
  LinkageSides s;

  s.fwd_C = crossSign(B, D, C);
  s.fwd_E = crossSign(B, C, E);
  s.inv_B = crossSign(A, E, B);
  s.inv_C = crossSign(B, E, C);
  s.inv_D = crossSign(C, A, D);

  return s;
}


// ------------------------------------------------------------
// Forward kinematics
// ------------------------------------------------------------

ForwardResult solveForward(Vec2 A,
                           const LinkageLengths &L,
                           float theta1,
                           float theta2,
                           const LinkageSides &sides) {

  ForwardResult r;
  r.valid = false;

  r.B = { A.x + L.AB * cosf(theta1),
          A.y + L.AB * sinf(theta1) };

  r.D = { A.x + L.DA * cosf(theta2),
          A.y + L.DA * sinf(theta2) };

  Vec2 c1, c2;
  if (!circleIntersect(r.B, L.BC, r.D, L.CD, c1, c2))
    return r;

  r.C = pickBySide(c1, c2, r.B, r.D, sides.fwd_C);

  Vec2 e1, e2;
  if (!circleIntersect(r.B, L.BE, r.C, L.CE, e1, e2))
    return r;

  r.E = pickBySide(e1, e2, r.B, r.C, sides.fwd_E);

  r.valid = true;
  return r;
}


// ------------------------------------------------------------
// Inverse kinematics
// ------------------------------------------------------------

InverseResult solveInverse(Vec2 A,
                           const LinkageLengths &L,
                           Vec2 E,
                           const LinkageSides &sides) {

  InverseResult r;
  r.valid = false;

  Vec2 b1, b2;
  if (!circleIntersect(A, L.AB, E, L.BE, b1, b2))
    return r;

  r.B = pickBySide(b1, b2, A, E, sides.inv_B);

  Vec2 c1, c2;
  if (!circleIntersect(r.B, L.BC, E, L.CE, c1, c2))
    return r;

  r.C = pickBySide(c1, c2, r.B, E, sides.inv_C);

  Vec2 d1, d2;
  if (!circleIntersect(r.C, L.CD, A, L.DA, d1, d2))
    return r;

  r.D = pickBySide(d1, d2, r.C, A, sides.inv_D);

  r.theta1 = atan2f(r.B.y - A.y, r.B.x - A.x);
  r.theta2 = atan2f(r.D.y - A.y, r.D.x - A.x);

  r.valid = true;
  return r;
}

#endif


LinkageLengths ll = {
  50,   // ground to B (crank 1)
  50,   // B to C (coupler base)
  50,   // C to D
  50,   // D to ground (crank 2)
  172.3,// B to E (triangle side)
  124.5,// C to E (triangle side)
};


/*
R = 0, back
L = 180, back
R = 180, forward
L = 0, forward
*/



Servo srR;
Servo srL;
Servo srB;

Vec2 A = {0, 0};
Vec2 B = {0, -50};
Vec2 C = {50, -50};
Vec2 D = {50, 0};
Vec2 E = {167.2, -92};

LinkageSides ls;

void fk(int l, int r){
  srL.write(180-l);
  srR.write(r);
}

void ik(float x, float y){
  InverseResult res = solveInverse(A, ll, {x,y}, ls);
  // Serial.println(res.theta1);
  // Serial.println(res.theta2);
  int r = round((res.theta1+M_PI*0.75)*180/M_PI);
  int l = round((res.theta2+M_PI*0.25)*180/M_PI);
  fk(l,r);
}

void setup() {

  Serial.begin(9600);

  srR.attach(9);
  srL.attach(10);
  srB.attach(8);

  ls = computeSides(A,B,C,D,E);

  srB.write(90);
  ik(167.2, -92);

  // for (int k = 0; k < 100; k++){
  //   int a = rand()%60+60;
  //   float d = (rand()%100)/100.0;
  //   srB.write(a);
  //   delay(200);
  //   ik(120+d*70,120-d*10);
  //   delay(600);
  //   ik(160+d*10,-80);
  //   delay(300);
  // }
  
}

const int BUFFER_SIZE = 16;
char buffer[BUFFER_SIZE];
byte index = 0;

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      buffer[index] = '\0';
      if (buffer[0] == 'S'){
        for (int i = 0; i < 3; i++){
          srB.write(50);
          delay(200);
          srB.write(70);
          delay(200);
        }
      }else{
        char *comma = strchr(buffer, ',');
        if (comma != NULL) {
          *comma = '\0';             
          int number1 = atoi(buffer);    
          int number2 = atoi(comma + 1);
          srB.write(60+number1);
          delay(200);
          float d = number2/100.0;
          ik(120+d*70,120-d*10);
          delay(600);
          ik(160+d*10,-80);
          delay(200);
          Serial.print("OK\n");
        }
      }
      index = 0;
    }
    else {
      if (index < BUFFER_SIZE - 1) {
        buffer[index++] = c;
      } else {
        index = 0;
      }
    }
  }

}
