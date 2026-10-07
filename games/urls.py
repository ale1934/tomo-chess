from django.contrib.auth.views import LoginView, LogoutView
from django.urls import path

from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("register/", views.register, name="register"),
    path("login/", LoginView.as_view(template_name="games/login.html", redirect_authenticated_user=True), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("games/create/", views.create_game, name="create_game"),
    path("games/join/", views.join_code, name="join_code"),
    path("game/<str:code>/", views.game_page, name="game"),
    path("friends/add/", views.friend_add, name="friend_add"),
    path("friends/<int:pk>/<str:action>/", views.friend_action, name="friend_action"),
]
