from collections import defaultdict

# Store engagement per room per user
rooms_engagement = defaultdict(lambda: defaultdict(lambda: {
    "engaged": 0,
    "total": 0
}))


def update_engagement(room_id: str, client_id: str, is_looking_forward: bool):

    user_data = rooms_engagement[room_id][client_id]

    user_data["total"] += 1

    if is_looking_forward:
        user_data["engaged"] += 1

    total = user_data["total"]
    engaged = user_data["engaged"]

    # total is always >= 1 here since we just incremented it
    return round((engaged / total) * 100, 2)