from setuptools import setup
setup(name='teamrocket_bridge', version='0.1.0', packages=['teamrocket_bridge'],
      data_files=[('share/ament_index/resource_index/packages', ['resource/teamrocket_bridge']),
                  ('share/teamrocket_bridge', ['package.xml'])],
      install_requires=['setuptools'], zip_safe=True,
      entry_points={'console_scripts': ['peer_bridge = teamrocket_bridge.peer_bridge:main']})
