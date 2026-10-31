import base64
import logging
import os

import cv2
import numpy as np

logger = logging.getLogger("meetsense")

_INPUT_SIZE = (320, 320)


class VisionAgent:
    """
    Headless face & attention detector powered by OpenCV's built-in
    FaceDetectorYN + YuNet ONNX model (compatible with OpenCV 4.x and 5.x).
    """

    def __init__(self):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        model_path = os.path.join(base_dir, "models", "face_detection_yunet_2023mar.onnx")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"YuNet ONNX model not found at: {model_path}")

        self.detector = cv2.FaceDetectorYN.create(
            model=model_path,
            config="",
            input_size=_INPUT_SIZE,
            score_threshold=0.5,
            nms_threshold=0.3,
            top_k=5000,
        )

    @staticmethod
    def _is_looking_forward(face: np.ndarray) -> bool:
        """
        Estimate whether the user is facing the camera using YuNet's 5 landmarks:
        [right_eye(4,5), left_eye(6,7), nose_tip(8,9), right_mouth(10,11), left_mouth(12,13)].
        """
        rx, ry = float(face[4]), float(face[5])
        lx, ly = float(face[6]), float(face[7])
        nx, ny = float(face[8]), float(face[9])
        rmx, rmy = float(face[10]), float(face[11])
        lmx, lmy = float(face[12]), float(face[13])

        eye_dist = float(np.hypot(lx - rx, ly - ry))
        if eye_dist < 8.0:
            return False

        # Horizontal yaw symmetry: nose tip should sit near the midpoint between both eyes
        eye_mid_x = (rx + lx) / 2.0
        yaw_offset = abs(nx - eye_mid_x) / eye_dist
        if yaw_offset > 0.42:
            return False

        # Head roll check (~30 deg tolerance)
        roll_ratio = abs(ly - ry) / eye_dist
        if roll_ratio > 0.55:
            return False

        # Vertical pitch check: nose vertically positioned between eye line and mouth line
        eye_mid_y = (ry + ly) / 2.0
        mouth_mid_y = (rmy + lmy) / 2.0
        face_vertical = mouth_mid_y - eye_mid_y
        if face_vertical <= 4.0:
            return False

        nose_pitch_ratio = (ny - eye_mid_y) / face_vertical
        return 0.18 <= nose_pitch_ratio <= 0.82

    def detect(self, image_data: str):
        try:
            if not image_data:
                return self._empty()

            encoded = image_data.split(",", 1)[-1]
            img_bytes = base64.b64decode(encoded)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is None or frame.size == 0:
                return self._empty()

            # Resize to fixed (320, 320) so OpenCV 4.x and 5.x ONNX engines never hit dynamic-shape mismatches
            resized = cv2.resize(frame, _INPUT_SIZE)
            self.detector.setInputSize(_INPUT_SIZE)
            _, faces = self.detector.detect(resized)

            if faces is None or len(faces) == 0:
                return self._empty()

            # Select the highest-confidence detected face
            best_face = max(faces, key=lambda f: float(f[14]))
            confidence = float(best_face[14])
            looking_forward = self._is_looking_forward(best_face)

            return {
                "face_detected": True,
                "looking_forward": bool(looking_forward),
                "confidence": round(confidence, 2),
            }

        except Exception as e:
            logger.error(f"Vision detection error: {e}")
            return self._empty()

    def _empty(self):
        return {
            "face_detected": False,
            "looking_forward": False,
            "confidence": 0.0,
        }
